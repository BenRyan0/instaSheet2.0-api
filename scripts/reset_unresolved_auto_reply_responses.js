/**
 * Resets isProcessed → false on Reply docs that are auto_reply_response
 * AND whose matching AutoReplyRecord is still unresolved (isResolved: false).
 *
 * Use this to force the scheduler to re-process these replies on the next run.
 *
 * Usage:
 *   node scripts/reset_unresolved_auto_reply_responses.js
 *   node scripts/reset_unresolved_auto_reply_responses.js --dry-run
 *
 * Requires MONGODB_URI in .env.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import AutoReplyRecord from '../models/AutoReplyRecord.js';
import Reply from '../models/Reply.js';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ Missing MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n');

  if (DRY_RUN) console.log('🔍 DRY-RUN mode — no writes will be made\n');

  // Step 1: Find all unresolved AutoReplyRecords
  const unresolvedRecords = await AutoReplyRecord.find({ isResolved: false }, 'lead_email campaign_id');
  console.log(`Found ${unresolvedRecords.length} unresolved AutoReplyRecord(s)`);

  if (!unresolvedRecords.length) {
    console.log('Nothing to reset.');
    await mongoose.disconnect();
    return;
  }

  // Step 2: Find matching auto_reply_response Replies for each unresolved record
  const conditions = unresolvedRecords.map(r => ({
    lead_email: r.lead_email,
    campaign_id: r.campaign_id,
  }));

  const replies = await Reply.find({
    replyType: 'auto_reply_response',
    isProcessed: true,
    $or: conditions,
  }, '_id lead_email campaign_id');

  console.log(`Found ${replies.length} processed auto_reply_response Reply doc(s) to reset\n`);

  if (!replies.length) {
    console.log('Nothing to reset.');
    await mongoose.disconnect();
    return;
  }

  // Step 3: Print what will be reset
  for (const r of replies) {
    console.log(`  • ${r.lead_email} / campaign ${r.campaign_id} — _id: ${r._id}`);
  }

  if (DRY_RUN) {
    console.log('\n✅ Dry-run complete — no changes made.');
    await mongoose.disconnect();
    return;
  }

  // Step 4: Reset isProcessed → false
  const ids = replies.map(r => r._id);
  const result = await Reply.updateMany(
    { _id: { $in: ids } },
    { $set: { isProcessed: false } }
  );

  console.log(`\n✅ Reset ${result.modifiedCount} Reply doc(s) → isProcessed: false`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
