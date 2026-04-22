/**
 * One-time backfill — populates firstName and companyName on all AutoReplyRecord
 * documents where either field is missing or empty.
 *
 * Source: reads "Lead Email", "Lead First Name", and "Company Name" columns
 * directly from each tenant's Google Sheet. No external API calls.
 *
 * Process:
 *   1. Find all AutoReplyRecord docs with missing/empty firstName or companyName.
 *   2. Group them by googleSheetId + sheetName.
 *   3. For each unique sheet, load credentials via Campaign → CampaignType → Tenant,
 *      read the full sheet once, and build a Map<email → { firstName, companyName }>.
 *   4. Update each record from the map.
 *
 * Safe to re-run: records that already have both fields set are skipped.
 *
 * Usage:
 *   node scripts/backfill_auto_reply_first_name.js
 *
 * Requires MONGODB_URI in .env.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import AutoReplyRecord from '../models/AutoReplyRecord.js';
import Campaign from '../models/Campaign.js';
import '../models/CampaignType.js';
import '../models/Tenant.js';
import { getGoogleClients } from '../services/googleClient.js';

dotenv.config();

async function buildSheetDataMap(sheets, googleSheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: googleSheetId,
    range: `${sheetName}!A1:ZZ`,
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return new Map();

  const headerRow = rows[0];
  const emailColIndex       = headerRow.findIndex(h => h?.trim().toLowerCase() === 'lead email');
  const firstNameColIndex   = headerRow.findIndex(h => h?.trim().toLowerCase() === 'lead first name');
  const companyNameColIndex = headerRow.findIndex(h => h?.trim().toLowerCase() === 'company name');

  if (emailColIndex === -1) {
    console.log(`   ⚠️  "Lead Email" column not found in "${sheetName}"`);
    return new Map();
  }

  if (firstNameColIndex === -1)   console.log(`   ⚠️  "Lead First Name" column not found in "${sheetName}" — will leave blank`);
  if (companyNameColIndex === -1) console.log(`   ⚠️  "Company Name" column not found in "${sheetName}" — will leave blank`);

  const dataMap = new Map();
  for (let i = 1; i < rows.length; i++) {
    const email = rows[i][emailColIndex]?.trim().toLowerCase();
    if (!email) continue;
    dataMap.set(email, {
      firstName:   firstNameColIndex   !== -1 ? (rows[i][firstNameColIndex]?.trim()   || '') : '',
      companyName: companyNameColIndex !== -1 ? (rows[i][companyNameColIndex]?.trim() || '') : '',
    });
  }

  console.log(`   📋 "${sheetName}" — loaded ${dataMap.size} row(s)`);
  return dataMap;
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
      { firstName:   { $exists: false } },
      { firstName:   '' },
      { companyName: { $exists: false } },
      { companyName: '' },
    ],
  });

  console.log(`Found ${records.length} AutoReplyRecord(s) with missing firstName or companyName\n`);

  if (records.length === 0) {
    await mongoose.connection.close();
    return;
  }

  // ── Group records by sheet target ─────────────────────────────────────────
  const sheetGroups = new Map(); // `${googleSheetId}:${sheetName}` → record[]
  for (const record of records) {
    const key = `${record.googleSheetId}:${record.sheetName}`;
    if (!sheetGroups.has(key)) sheetGroups.set(key, []);
    sheetGroups.get(key).push(record);
  }

  console.log(`Grouped into ${sheetGroups.size} unique sheet target(s)\n`);

  // Cache credentials per campaign_id to avoid repeated DB lookups.
  const credentialsCache = new Map();

  let updated = 0;
  let skipped = 0;
  let failed  = 0;

  for (const [, groupRecords] of sheetGroups) {
    const { googleSheetId, sheetName } = groupRecords[0];
    console.log(`\n📄 Sheet: "${sheetName}" (${googleSheetId})`);
    console.log(`   Records in this group: ${groupRecords.length}`);

    // ── Resolve Google credentials via any record in the group ────────────────
    let serviceAccountJson = null;

    for (const record of groupRecords) {
      let creds = credentialsCache.get(record.campaign_id);

      if (!creds) {
        const campaign = await Campaign.findOne({ campaignId: record.campaign_id })
          .populate({ path: 'campaignType', populate: { path: 'tenant' } });
        creds = campaign?.campaignType?.tenant?.credentials?.googleServiceAccountJson;
        if (creds) credentialsCache.set(record.campaign_id, creds);
      }

      if (creds) {
        serviceAccountJson = creds;
        break;
      }
    }

    if (!serviceAccountJson) {
      console.log(`   ❌ No Google credentials found for this sheet — skipping group`);
      skipped += groupRecords.length;
      continue;
    }

    // ── Read sheet once and build email → { firstName, companyName } map ──────
    let dataMap;
    try {
      const { sheets } = await getGoogleClients(serviceAccountJson);
      dataMap = await buildSheetDataMap(sheets, googleSheetId, sheetName);
    } catch (err) {
      console.error(`   ❌ Failed to read sheet: ${err.message}`);
      skipped += groupRecords.length;
      continue;
    }

    if (dataMap.size === 0) {
      console.log(`   ⚠️  No rows found in sheet — skipping group`);
      skipped += groupRecords.length;
      continue;
    }

    // ── Update each record from the map ───────────────────────────────────────
    for (const record of groupRecords) {
      const entry = dataMap.get(record.lead_email?.toLowerCase().trim());

      if (!entry) {
        console.log(`   ⏭️  ${record.lead_email} — not found in sheet`);
        skipped++;
        continue;
      }

      // Only write fields that are currently missing.
      const update = {};
      if (!record.firstName   && entry.firstName)   update.firstName   = entry.firstName;
      if (!record.companyName && entry.companyName) update.companyName = entry.companyName;

      if (Object.keys(update).length === 0) {
        console.log(`   ⏭️  ${record.lead_email} — already complete`);
        skipped++;
        continue;
      }

      try {
        await AutoReplyRecord.updateOne({ _id: record._id }, { $set: update });
        const parts = [];
        if (update.firstName)   parts.push(`firstName: "${update.firstName}"`);
        if (update.companyName) parts.push(`companyName: "${update.companyName}"`);
        console.log(`   ✅ ${record.lead_email} — ${parts.join(' | ')}`);
        updated++;
      } catch (err) {
        console.error(`   ❌ Update failed for ${record.lead_email}: ${err.message}`);
        failed++;
      }
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
