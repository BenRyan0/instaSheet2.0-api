/**
 * One-time backfill script — sends data-request follow-up emails to leads
 * already encoded in rows 2–51 of "senior-DRUG-PLAN_iLeads" who are missing
 * one or more of: Phone From Reply, Insurance Provider, Medicare Advantage Type, Medicaid.
 *
 * Safe to re-run: leads that already have an unresolved DataRequest are skipped.
 *
 * Usage:
 *   node scripts/backfill_data_requests.js
 *
 * Requires MONGODB_URI in .env. All other credentials are loaded from MongoDB.
 */

import mongoose from 'mongoose';
import axios from 'axios';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

import CampaignType from '../models/CampaignType.js';
import '../models/Tenant.js'; // must be imported so Mongoose registers the schema before populate()
import DataRequest from '../models/DataRequest.js';
import Reply from '../models/Reply.js';

dotenv.config();

// =======================
// Config
// =======================
const SHEET_NAME       = 'senior-DRUG-PLAN_iLeads';
const MAX_ROW          = 51;   // inclusive, 1-based (row 1 = headers, rows 2–51 = data)
const DELAY_BETWEEN_MS = 2500; // pause between Instantly sends to avoid rate limits

// Sheet column names that must be non-empty; any blank triggers a follow-up.
const REQUIRED_FIELDS = [
  'Phone From Reply',
  'Insurance Provider',
  'Medicare Advantage Type',
  'Medicaid',
];

// =======================
// Helpers
// =======================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function columnLetter(index) {
  let letter = '';
  let i = index;
  while (i > 0) {
    const mod = (i - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    i = Math.floor((i - mod) / 26);
  }
  return letter;
}

function plainTextToHtml(text) {
  if (!text) return '';
  return text
    .split(/\n\n+/)
    .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function personalizeTemplate(bodyText, companyName, senderName) {
  return bodyText
    .replace(/\{\{Company Name\}\}/g, companyName || '')
    .replace(/\{\{sendingAccountName\}\}/g, senderName || '');
}

async function fetchSenderName(emailAccount, instantlyApiKey) {
  try {
    const res = await axios.get(
      `https://api.instantly.ai/api/v2/accounts/${encodeURIComponent(emailAccount)}`,
      { headers: { Authorization: `Bearer ${instantlyApiKey}` }, timeout: 10000 }
    );
    const { first_name = '', last_name = '' } = res.data || {};
    return [first_name, last_name].filter(Boolean).join(' ').trim() ||
      emailAccount.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return emailAccount.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

// =======================
// Main
// =======================
async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ Missing MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n');

  // ── 1. Load CampaignType + tenant credentials ──────────────────────────────
  const ct = await CampaignType.findOne({ sheetName: SHEET_NAME }).populate('tenant');
  if (!ct) {
    console.error(`❌ No CampaignType found for sheetName "${SHEET_NAME}"`);
    process.exit(1);
  }

  const tenant         = ct.tenant;
  const instantlyKey   = tenant.credentials.instantlyApiKey;
  const googleCreds    = tenant.credentials.googleServiceAccountJson;
  const googleSheetId  = tenant.googleSheetId;
  const drConfig       = ct.dataRequestFollowUp;

  if (!drConfig?.enabled) {
    console.warn('⚠️  dataRequestFollowUp is not enabled on this CampaignType.');
    console.warn('   Enable it via PUT /api/campaign-types/:id before running this script.');
    process.exit(1);
  }
  if (!drConfig.bodyText) {
    console.error('❌ dataRequestFollowUp.bodyText is empty — configure it first.');
    process.exit(1);
  }

  console.log(`✓ CampaignType: "${ct.name}"`);
  console.log(`  Sheet: "${SHEET_NAME}" | Sheet ID: ${googleSheetId}`);
  console.log(`  Required fields: ${REQUIRED_FIELDS.join(', ')}\n`);

  // ── 2. Init Google Sheets client ───────────────────────────────────────────
  const auth = new GoogleAuth({
    credentials: googleCreds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });

  // ── 3. Read sheet rows 2–51 ────────────────────────────────────────────────
  const lastCol      = columnLetter(ct.sheetHeaders.length); // e.g. "AB" for 28 headers
  const readRange    = `${SHEET_NAME}!A2:${lastCol}${MAX_ROW}`;

  console.log(`📋 Reading ${readRange} ...`);
  const sheetRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: googleSheetId,
    range: readRange,
  });

  const rows = sheetRes.data.values || [];
  console.log(`   ${rows.length} row(s) returned\n`);

  if (rows.length === 0) {
    console.log('No data rows found. Nothing to backfill.');
    await mongoose.connection.close();
    return;
  }

  // Build column index map from sheetHeaders.
  const headerIndex = Object.fromEntries(ct.sheetHeaders.map((h, i) => [h, i]));

  const emailIdx = headerIndex['Lead Email'];
  if (emailIdx === undefined) {
    console.error('❌ "Lead Email" not found in sheetHeaders');
    process.exit(1);
  }

  // ── 4. Process each row ────────────────────────────────────────────────────
  let sent    = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row       = rows[i];
    const sheetRow  = i + 2; // 1-based sheet row number (row 1 = header)
    const leadEmail = row[emailIdx]?.trim()?.toLowerCase();

    if (!leadEmail) {
      console.log(`Row ${sheetRow}: ⏭️  Skipped — no email`);
      skipped++;
      continue;
    }

    // Check which required fields are blank in this row.
    const missingFields = REQUIRED_FIELDS.filter(field => {
      const idx = headerIndex[field];
      return idx === undefined || !row[idx]?.trim();
    });

    if (missingFields.length === 0) {
      console.log(`Row ${sheetRow}: ⏭️  Skipped — all required fields present (${leadEmail})`);
      skipped++;
      continue;
    }

    // Skip if an unresolved DataRequest already exists.
    const existing = await DataRequest.findOne({ lead_email: leadEmail, isResolved: false });
    if (existing) {
      console.log(`Row ${sheetRow}: ⏭️  Skipped — DataRequest already exists (${leadEmail})`);
      skipped++;
      continue;
    }

    // Look up the original Reply to get threading info.
    const originalReply = await Reply.findOne({ lead_email: leadEmail }).sort({ createdAt: 1 });
    if (!originalReply) {
      console.log(`Row ${sheetRow}: ⏭️  Skipped — no Reply found in DB for (${leadEmail})`);
      skipped++;
      continue;
    }
    if (!originalReply.email_id) {
      console.log(`Row ${sheetRow}: ⏭️  Skipped — Reply has no email_id for threading (${leadEmail})`);
      skipped++;
      continue;
    }
    if (!originalReply.email_account) {
      console.log(`Row ${sheetRow}: ⏭️  Skipped — Reply has no email_account (${leadEmail})`);
      skipped++;
      continue;
    }

    // Personalize and send.
    console.log(`Row ${sheetRow}: 📤 Sending to ${leadEmail} — missing: ${missingFields.join(', ')}`);

    try {
      const senderName = await fetchSenderName(originalReply.email_account, instantlyKey);
      const companyName = originalReply.company_name || '';

      const personalizedText = personalizeTemplate(drConfig.bodyText, companyName, senderName);
      const personalizedHtml = plainTextToHtml(personalizedText);

      await axios.post(
        'https://api.instantly.ai/api/v2/emails/reply',
        {
          eaccount:      originalReply.email_account,
          reply_to_uuid: originalReply.email_id,
          subject:       originalReply.reply_subject || '',
          body:          { html: personalizedHtml, text: personalizedText },
        },
        {
          headers: {
            Authorization:  `Bearer ${instantlyKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      await DataRequest.create({
        lead_email:      leadEmail,
        campaign_id:     originalReply.campaign_id,
        googleSheetId,
        sheetName:       SHEET_NAME,
        sheetRowNumber:  sheetRow,
        requestedFields: missingFields,
        emailAccount:    originalReply.email_account,
        replyEmailId:    originalReply.email_id,
      });

      console.log(`        ✅ Sent + DataRequest saved (row ${sheetRow})`);
      sent++;

      await sleep(DELAY_BETWEEN_MS);
    } catch (err) {
      console.error(`        ❌ Failed for ${leadEmail}:`, err.response?.data || err.message);
      skipped++;
    }
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done — Sent: ${sent} | Skipped: ${skipped}`);
  console.log('='.repeat(50));

  await mongoose.connection.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
