/**
 * Reads all tenant Google Sheets and prints every lead email where the
 * "Details" column contains more than 2 occurrences of "REPLY:".
 *
 * A count > 2 means the lead has sent 3 or more follow-up replies after
 * the initial auto-reply was sent.
 *
 * Usage:
 *   node scripts/find_multi_reply_leads.js
 *
 * Requires MONGODB_URI in .env. Google credentials are loaded from MongoDB.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Campaign from '../models/Campaign.js';
import '../models/CampaignType.js';
import '../models/Tenant.js';
import { getGoogleClients } from '../services/googleClient.js';

dotenv.config();

const REPLY_MARKER = 'REPLY:';
const THRESHOLD    = 2; // show leads with MORE than this many occurrences

function countOccurrences(str, marker) {
  if (!str) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(marker, pos)) !== -1) {
    count++;
    pos += marker.length;
  }
  return count;
}

async function scanSheet(sheets, googleSheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: googleSheetId,
    range: `${sheetName}!A1:ZZ`,
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];

  const headerRow       = rows[0];
  const emailColIndex   = headerRow.findIndex(h => h?.trim().toLowerCase() === 'lead email');
  const detailsColIndex = headerRow.findIndex(h => h?.trim().toLowerCase() === 'details');

  if (emailColIndex === -1) {
    console.log(`   ⚠️  "Lead Email" column not found in "${sheetName}" — skipping`);
    return [];
  }
  if (detailsColIndex === -1) {
    console.log(`   ⚠️  "Details" column not found in "${sheetName}" — skipping`);
    return [];
  }

  const matches = [];
  for (let i = 1; i < rows.length; i++) {
    const email   = rows[i][emailColIndex]?.trim();
    const details = rows[i][detailsColIndex] || '';
    const count   = countOccurrences(details, REPLY_MARKER);
    if (count > THRESHOLD) {
      matches.push({ email, replyCount: count, row: i + 1 });
    }
  }

  return matches;
}

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ Missing MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n');

  // Load all active Campaign → CampaignType → Tenant chains.
  const campaigns = await Campaign.find({ isActive: true }).populate({
    path: 'campaignType',
    populate: { path: 'tenant' },
  });

  // Deduplicate by googleSheetId:sheetName and collect credentials.
  const sheetTargets = new Map(); // `${googleSheetId}:${sheetName}` → { googleSheetId, sheetName, serviceAccountJson }
  for (const campaign of campaigns) {
    const ct     = campaign.campaignType;
    const tenant = ct?.tenant;
    if (!ct || !tenant || !ct.isActive || !tenant.isActive) continue;

    const key = `${tenant.googleSheetId}:${ct.sheetName}`;
    if (!sheetTargets.has(key)) {
      sheetTargets.set(key, {
        googleSheetId:      tenant.googleSheetId,
        sheetName:          ct.sheetName,
        tenantName:         tenant.name,
        serviceAccountJson: tenant.credentials.googleServiceAccountJson,
      });
    }
  }

  console.log(`Found ${sheetTargets.size} unique sheet target(s) across all tenants\n`);

  const results = []; // { tenantName, sheetName, email, replyCount, row }

  for (const [, target] of sheetTargets) {
    const { googleSheetId, sheetName, tenantName, serviceAccountJson } = target;
    console.log(`📄 Scanning "${sheetName}" [${tenantName}]...`);

    try {
      const { sheets } = await getGoogleClients(serviceAccountJson);
      const matches    = await scanSheet(sheets, googleSheetId, sheetName);

      if (matches.length === 0) {
        console.log(`   ✅ No leads with > ${THRESHOLD} replies\n`);
      } else {
        console.log(`   ⚡ ${matches.length} lead(s) found\n`);
        for (const m of matches) {
          results.push({ tenantName, sheetName, ...m });
        }
      }
    } catch (err) {
      console.error(`   ❌ Failed to read sheet: ${err.message}\n`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  if (results.length === 0) {
    console.log(`No leads found with more than ${THRESHOLD} "${REPLY_MARKER}" occurrences.`);
  } else {
    console.log(`Found ${results.length} lead(s) with > ${THRESHOLD} "${REPLY_MARKER}" in Details:\n`);
    for (const r of results) {
      console.log(`  [${r.tenantName} / ${r.sheetName}] row ${r.row} — ${r.email} (${r.replyCount}x REPLY:)`);
    }
  }
  console.log('='.repeat(60));

  await mongoose.connection.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
