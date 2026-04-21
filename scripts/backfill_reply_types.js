/**
 * One-time backfill — stamps replyType on all existing Reply documents.
 *
 * Types assigned:
 *   'fresh'               — original cold-email reply (or no follow-up record exists)
 *   'auto_reply_response' — lead replied to our auto-reply or scheduled follow-up
 *   'data_fill_response'  — lead replied to our data-request follow-up
 *
 * Classification logic:
 *   1. If reply.email_id matches an AutoReplyRecord.replyEmailId → 'fresh'
 *      (this was the original cold reply that triggered the auto-reply send)
 *   2. Else if AutoReplyRecord exists for (lead_email + campaign_id)
 *      AND reply.createdAt > AutoReplyRecord.createdAt → 'auto_reply_response'
 *   3. If reply.email_id matches a DataRequest.replyEmailId → 'fresh'
 *   4. Else if DataRequest exists for (lead_email + campaign_id)
 *      AND reply.createdAt > DataRequest.createdAt → 'data_fill_response'
 *   5. Default → 'fresh'
 *
 * Safe to re-run: skips Reply docs that already have replyType set.
 *
 * Usage:
 *   node scripts/backfill_reply_types.js
 *
 * Requires MONGODB_URI in .env.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Reply from '../models/Reply.js';
import AutoReplyRecord from '../models/AutoReplyRecord.js';
import DataRequest from '../models/DataRequest.js';

dotenv.config();

const BATCH_SIZE = 500;

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ Missing MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n');

  // Phase 1 — Build lookup sets from AutoReplyRecord and DataRequest.
  // replyEmailId is the email_id of the original cold reply that triggered each send.
  console.log('📋 Phase 1 — Loading AutoReplyRecord and DataRequest reference sets...');

  const autoReplyRecords = await AutoReplyRecord.find({}, {
    replyEmailId: 1, lead_email: 1, campaign_id: 1, createdAt: 1,
  }).lean();

  const dataRequests = await DataRequest.find({}, {
    replyEmailId: 1, lead_email: 1, campaign_id: 1, createdAt: 1,
  }).lean();

  // email_id values of original cold replies (the ones that triggered our sends)
  const originalAutoReplyEmailIds = new Set(
    autoReplyRecords.map(r => r.replyEmailId).filter(Boolean)
  );
  const originalDataRequestEmailIds = new Set(
    dataRequests.map(r => r.replyEmailId).filter(Boolean)
  );

  // Keyed maps: `lead_email:campaign_id` → earliest createdAt
  // (used to determine if a Reply came after the follow-up record was created)
  const autoReplyByKey = new Map();
  for (const r of autoReplyRecords) {
    const key = `${r.lead_email}:${r.campaign_id}`;
    const existing = autoReplyByKey.get(key);
    if (!existing || r.createdAt < existing) autoReplyByKey.set(key, r.createdAt);
  }

  const dataRequestByKey = new Map();
  for (const r of dataRequests) {
    const key = `${r.lead_email}:${r.campaign_id}`;
    const existing = dataRequestByKey.get(key);
    if (!existing || r.createdAt < existing) dataRequestByKey.set(key, r.createdAt);
  }

  console.log(`   AutoReplyRecord original email_ids : ${originalAutoReplyEmailIds.size}`);
  console.log(`   AutoReplyRecord lead+campaign keys : ${autoReplyByKey.size}`);
  console.log(`   DataRequest original email_ids     : ${originalDataRequestEmailIds.size}`);
  console.log(`   DataRequest lead+campaign keys     : ${dataRequestByKey.size}\n`);

  // Phase 2 — Classify Reply docs that have no replyType yet.
  console.log('📋 Phase 2 — Classifying untagged Reply documents...\n');

  const total = await Reply.countDocuments({ replyType: { $exists: false } });
  console.log(`   Found ${total} untagged Reply doc(s)\n`);

  if (total === 0) {
    console.log('✅ Nothing to classify — all Reply docs already tagged.');
    await mongoose.connection.close();
    return;
  }

  let processed = 0;
  let counts = { fresh: 0, auto_reply_response: 0, data_fill_response: 0 };

  const bulkOps = [];

  let skip = 0;
  while (skip < total) {
    const batch = await Reply.find(
      { replyType: { $exists: false } },
      { _id: 1, email_id: 1, lead_email: 1, campaign_id: 1, createdAt: 1 }
    ).skip(skip).limit(BATCH_SIZE).lean();

    if (batch.length === 0) break;

    for (const reply of batch) {
      const key = `${reply.lead_email}:${reply.campaign_id}`;
      let type = 'fresh';

      if (reply.email_id && originalAutoReplyEmailIds.has(reply.email_id)) {
        // This email_id is the original cold reply that triggered an auto-reply — it's fresh
        type = 'fresh';
      } else if (autoReplyByKey.has(key) && reply.createdAt > autoReplyByKey.get(key)) {
        // Came after an AutoReplyRecord was created for this lead+campaign
        type = 'auto_reply_response';
      } else if (reply.email_id && originalDataRequestEmailIds.has(reply.email_id)) {
        // This email_id is the original cold reply that triggered a data request — it's fresh
        type = 'fresh';
      } else if (dataRequestByKey.has(key) && reply.createdAt > dataRequestByKey.get(key)) {
        // Came after a DataRequest was created for this lead+campaign
        type = 'data_fill_response';
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: reply._id },
          update: { $set: { replyType: type } },
        },
      });

      counts[type]++;
      processed++;
    }

    // Flush bulk ops every batch
    if (bulkOps.length > 0) {
      await Reply.bulkWrite(bulkOps.splice(0));
    }

    skip += BATCH_SIZE;
    console.log(`   Progress: ${Math.min(processed, total)} / ${total}`);
  }

  // Flush any remaining ops
  if (bulkOps.length > 0) {
    await Reply.bulkWrite(bulkOps);
  }

  console.log('\n' + '='.repeat(50));
  console.log('✅ Backfill complete');
  console.log(`   fresh               : ${counts.fresh}`);
  console.log(`   auto_reply_response : ${counts.auto_reply_response}`);
  console.log(`   data_fill_response  : ${counts.data_fill_response}`);
  console.log(`   total classified    : ${processed}`);
  console.log('='.repeat(50));

  console.log('\nVerification query:');
  console.log('  db.replies.aggregate([{$group:{_id:"$replyType",count:{$sum:1}}}])');

  await mongoose.connection.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
