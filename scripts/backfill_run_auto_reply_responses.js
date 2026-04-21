/**
 * One-time backfill — runs historical auto-reply responses through the
 * categorized response process (analyzeReplyEligibility → template selection
 * → send via Instantly).
 *
 * Prerequisites:
 *   1. scripts/backfill_reply_types.js has been run (replies are classified)
 *   2. The categorized response feature is deployed (autoReplyResponses config
 *      exists on CampaignType and sendCategorizedResponse is available)
 *   3. autoReplyResponses.enabled = true on the relevant CampaignTypes
 *
 * Flags:
 *   --dry-run      Log what would be sent without calling Instantly
 *   --delay-ms N   Milliseconds to wait between sends (default 2000)
 *
 * Usage:
 *   node scripts/backfill_run_auto_reply_responses.js --dry-run
 *   node scripts/backfill_run_auto_reply_responses.js --delay-ms 3000
 *
 * Requires MONGODB_URI in .env.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Reply from '../models/Reply.js';
import AutoReplyRecord from '../models/AutoReplyRecord.js';
import { hydrateRouteCache, getRouteForCampaign } from '../services/routingService.js';

dotenv.config();

const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const DELAY_MS = (() => {
  const idx = args.indexOf('--delay-ms');
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1]) : 2000;
})();

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ Missing MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected');

  if (DRY_RUN) console.log('🔍 DRY RUN — no emails will be sent\n');
  console.log(`⏱  Delay between sends: ${DELAY_MS}ms\n`);

  await hydrateRouteCache();
  console.log('✓ Route cache loaded\n');

  // Find all auto-reply response replies that are processed
  const replies = await Reply.find({
    replyType: 'auto_reply_response',
    isProcessed: true,
  }).sort({ createdAt: 1 }).lean();

  console.log(`Found ${replies.length} auto_reply_response Reply doc(s)\n`);

  if (replies.length === 0) {
    console.log('✅ Nothing to process.');
    await mongoose.connection.close();
    return;
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const reply of replies) {
    const route = getRouteForCampaign(reply.campaign_id);

    if (!route) {
      console.log(`⏭️  No route for campaign ${reply.campaign_id} — ${reply.lead_email}`);
      skipped++;
      continue;
    }

    if (!route.autoReplyResponses?.enabled) {
      console.log(`⏭️  autoReplyResponses disabled for campaign type "${route.campaignType}" — ${reply.lead_email}`);
      skipped++;
      continue;
    }

    // Find the matching AutoReplyRecord to check responseCount
    const autoReplyRecord = await AutoReplyRecord.findOne({
      lead_email:  reply.lead_email,
      campaign_id: reply.campaign_id,
    });

    const maxResponses     = route.autoReplyResponses.maxResponses ?? 1;
    const currentCount     = autoReplyRecord?.responseCount ?? 0;

    if (currentCount >= maxResponses) {
      console.log(`⏭️  Already responded (${currentCount}/${maxResponses}) — ${reply.lead_email}`);
      skipped++;
      continue;
    }

    const replyText = reply.reply_text_snippet || reply.reply_text || '';
    if (!replyText) {
      console.log(`⏭️  No reply text — ${reply.lead_email}`);
      skipped++;
      continue;
    }

    console.log(`\n📨 Processing: ${reply.lead_email} (campaign: ${reply.campaign_id})`);

    if (DRY_RUN) {
      console.log(`   [DRY RUN] Would analyze + send categorized response`);
      console.log(`   replyText: "${replyText.substring(0, 100)}..."`);
      sent++;
      continue;
    }

    try {
      // Dynamically import the functions needed from index.js.
      // NOTE: These functions are not exported from index.js yet.
      // When the categorized response feature is built, export
      // analyzeReplyEligibility, categorizeForResponse, and sendCategorizedResponse
      // from index.js (or move them to a shared service), then import them here.
      //
      // Placeholder — replace with actual import once feature is deployed:
      console.log(`   ⚠️  Categorized response feature not yet deployed — skipping send`);
      console.log(`   To complete: export analyzeReplyEligibility + sendCategorizedResponse from index.js`);
      skipped++;
      continue;

      // --- Intended logic (uncomment once feature is exported) ---
      // const { analyzeReplyEligibility, categorizeForResponse, sendCategorizedResponse } = await import('../index.js');
      // const openaiClient = getOpenAIClient(route.tenantCredentials.openAiApiKey);
      // const analysis = await analyzeReplyEligibility(replyText, reply.reply_subject || '', { campaignType: route.campaignType, emailTemplate: route.emailTemplate }, openaiClient);
      // const category  = categorizeForResponse(analysis);
      // const instantlyApiKey = route.tenantCredentials.instantlyApiKey;
      // const sendReply = { ...reply, email_id: autoReplyRecord?.replyEmailId || reply.email_id };
      // const sentOk = await sendCategorizedResponse(sendReply, category, route, null, openaiClient, instantlyApiKey);
      // if (sentOk && autoReplyRecord) {
      //   const newCount = currentCount + 1;
      //   const update = { $inc: { responseCount: 1 } };
      //   if (newCount >= maxResponses) update.$set = { isResolved: true };
      //   await AutoReplyRecord.updateOne({ _id: autoReplyRecord._id }, update);
      // }
      // sent++;
    } catch (err) {
      console.error(`❌ Failed for ${reply.lead_email}: ${err.message}`);
      failed++;
    }

    if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   Sent    : ${sent}`);
  console.log(`   Skipped : ${skipped}`);
  console.log(`   Failed  : ${failed}`);
  console.log('='.repeat(50));

  await mongoose.connection.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
