/**
 * One-time backfill — fills all new fields added to AutoReplyRecord:
 *   emailAccount, replyEmailId, replySubject  ← sourced from matching Reply document
 *   followUpCount                             ← default 0
 *   lastFollowUpAt                            ← default null
 *
 * Safe to re-run: records that already have all fields set are skipped.
 *
 * Usage:
 *   node scripts/backfill_auto_reply_records.js
 *
 * Requires MONGODB_URI in .env.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import AutoReplyRecord from '../models/AutoReplyRecord.js';
import Reply from '../models/Reply.js';

dotenv.config();

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ Missing MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n');

  // Find every record missing ANY of the new fields.
  const records = await AutoReplyRecord.find({
    $or: [
      { emailAccount:   { $exists: false } },
      { emailAccount:   '' },
      { replyEmailId:   { $exists: false } },
      { replyEmailId:   '' },
      { replySubject:   { $exists: false } },
      { leadFirstName:  { $exists: false } },
      { followUpCount:  { $exists: false } },
      { lastFollowUpAt: { $exists: false } },
    ],
  });

  // ── Step 1: bulk-set numeric/date defaults directly in MongoDB ───────────────
  // Must use updateMany (not Mongoose save) — Mongoose applies schema defaults
  // to in-memory docs, making $exists: false checks unreliable after fetch.
  const defaultsResult = await AutoReplyRecord.updateMany(
    { $or: [{ followUpCount: { $exists: false } }, { lastFollowUpAt: { $exists: false } }] },
    { $set: { followUpCount: 0, lastFollowUpAt: null } }
  );
  console.log(`✅ followUpCount/lastFollowUpAt defaults applied to ${defaultsResult.modifiedCount} record(s)\n`);

  console.log(`Found ${records.length} AutoReplyRecord(s) needing threading field backfill\n`);

  let updated = 0;
  let skipped = 0;

  for (const record of records) {
    const update = {};

    // ── Threading fields — source from oldest matching Reply ──────────────────
    const needsThreading = !record.emailAccount || !record.replyEmailId;

    if (needsThreading) {
      const reply = await Reply.findOne({
        lead_email:  record.lead_email,
        campaign_id: record.campaign_id,
      }).sort({ createdAt: 1 });

      if (!reply) {
        console.log(`⏭️  No Reply found   — ${record.lead_email}`);
        skipped++;
        continue;
      }

      if (!reply.email_account || !reply.email_id) {
        console.log(`⏭️  Reply incomplete — ${record.lead_email} (missing email_account or email_id)`);
        skipped++;
        continue;
      }

      update.emailAccount  = reply.email_account;
      update.replyEmailId  = reply.email_id;
      update.replySubject  = reply.reply_subject || '';
      update.leadFirstName = reply.display_name?.split(' ')[0] || '';
    }

    if (Object.keys(update).length === 0) {
      console.log(`⏭️  Already complete — ${record.lead_email}`);
      skipped++;
      continue;
    }

    await AutoReplyRecord.updateOne({ _id: record._id }, { $set: update });

    console.log(`✅ Updated — ${record.lead_email}`);
    if (update.emailAccount) console.log(`   emailAccount : ${update.emailAccount}`);
    if (update.replyEmailId) console.log(`   replyEmailId : ${update.replyEmailId}`);
    if (update.replySubject !== undefined) console.log(`   replySubject : ${update.replySubject || '(empty)'}`);
    console.log();
    updated++;
  }

  console.log('='.repeat(50));
  console.log(`✅ Done — Updated: ${updated} | Skipped: ${skipped}`);
  console.log('='.repeat(50));

  await mongoose.connection.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
