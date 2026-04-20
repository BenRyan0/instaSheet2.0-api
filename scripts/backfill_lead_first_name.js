/**
 * One-time backfill — populates leadFirstName on all AutoReplyRecord documents
 * where the field is missing or empty.
 *
 * Primary source : Instantly API (first_name field on the lead)
 * Fallback source: Reply.display_name (first word, parsed locally)
 *
 * Safe to re-run: records that already have a non-empty leadFirstName are skipped.
 *
 * Usage:
 *   node scripts/backfill_lead_first_name.js
 *
 * Requires MONGODB_URI in .env. Instantly API keys are loaded from MongoDB.
 */

import mongoose from 'mongoose';
import axios from 'axios';
import dotenv from 'dotenv';

import AutoReplyRecord from '../models/AutoReplyRecord.js';
import Campaign from '../models/Campaign.js';
import '../models/CampaignType.js';
import '../models/Tenant.js';
import Reply from '../models/Reply.js';

dotenv.config();

const DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchFirstNameFromInstantly(leadEmail, instantlyApiKey) {
  try {
    const res = await axios.post(
      'https://api.instantly.ai/api/v2/leads/list',
      { contacts: [leadEmail], limit: 1 },
      {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${instantlyApiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const firstName = res.data?.items?.[0]?.first_name?.trim();
    return firstName || null;
  } catch (err) {
    console.warn(`   ⚠️  Instantly lookup failed for ${leadEmail}: ${err.message}`);
    return null;
  }
}

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ Missing MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n');

  const records = await AutoReplyRecord.find({
    $or: [
      { leadFirstName: { $exists: false } },
      { leadFirstName: '' },
    ],
  });

  console.log(`Found ${records.length} AutoReplyRecord(s) with missing leadFirstName\n`);

  // Cache instantlyApiKey per campaign_id to avoid repeated DB lookups.
  const apiKeyCache = new Map();

  let updated = 0;
  let skipped = 0;
  let failed  = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    console.log(`[${i + 1}/${records.length}] ${record.lead_email}`);

    // ── Resolve Instantly API key ─────────────────────────────────────────────
    let instantlyApiKey = apiKeyCache.get(record.campaign_id);

    if (!instantlyApiKey) {
      const campaign = await Campaign.findOne({ campaignId: record.campaign_id })
        .populate({ path: 'campaignType', populate: { path: 'tenant' } });

      instantlyApiKey = campaign?.campaignType?.tenant?.credentials?.instantlyApiKey;

      if (instantlyApiKey) {
        apiKeyCache.set(record.campaign_id, instantlyApiKey);
      }
    }

    // ── Try Instantly first ───────────────────────────────────────────────────
    let firstName = null;

    if (instantlyApiKey) {
      firstName = await fetchFirstNameFromInstantly(record.lead_email, instantlyApiKey);
      if (firstName) {
        console.log(`   ✅ Instantly → "${firstName}"`);
      }
      await sleep(DELAY_MS);
    } else {
      console.log(`   ⚠️  No Instantly API key found for campaign ${record.campaign_id}`);
    }

    // ── Fallback: Reply.display_name ──────────────────────────────────────────
    if (!firstName) {
      const reply = await Reply.findOne({
        lead_email:  record.lead_email,
        campaign_id: record.campaign_id,
      }).sort({ createdAt: 1 });

      const parsed = reply?.display_name?.split(' ')[0]?.trim();
      if (parsed) {
        firstName = parsed;
        console.log(`   ✅ Reply fallback → "${firstName}"`);
      }
    }

    // ── Update or skip ────────────────────────────────────────────────────────
    if (!firstName) {
      console.log(`   ⏭️  No name found — skipping`);
      skipped++;
      continue;
    }

    try {
      await AutoReplyRecord.updateOne({ _id: record._id }, { $set: { leadFirstName: firstName } });
      updated++;
    } catch (err) {
      console.error(`   ❌ Update failed: ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done — Updated: ${updated} | Skipped: ${skipped} | Failed: ${failed}`);
  console.log('='.repeat(50));

  await mongoose.connection.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
