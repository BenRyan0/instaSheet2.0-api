/**
 * Migration script — converts the hardcoded CAMPAIGN_SHEET_ROUTING into
 * the multi-tenant DB schema (Tenant → CampaignType → Campaign).
 *
 * Now splits B2B into its own tenant.
 *
 * Safe to run multiple times; uses upserts throughout.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import Tenant from '../models/Tenant.js';
import CampaignType from '../models/CampaignType.js';
import Campaign from '../models/Campaign.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// =======================
// Campaign Data
// =======================
const CAMPAIGN_DATA = [
  {
    sheetName: 'senior-DRUG-PLAN_iLeads',
    name: 'Senior Free Phone & Drug Plan',
    manualColCount: 0,
    addressMapping: 'direct',
    emailTemplate: `Hi {{firstName}},
You may be eligible for three new programs designed to lower your monthly bills at zero cost to you:
* Telehealth Telecom: A free smartphone with reliable cellular service.
* Free Drug Plan & Mail Order Pharmacy Benefits: Free, home-delivered prescription medications.
* Personal Care Coordination: Direct access to a dedicated health assistant.
To qualify, reply with:
1. Best phone number?
2. Insurance provider?
3. HMO or PPO?
4. Medicaid? (Yes/No)
{{sendingAccountName}}`,
    campaignIds: [
      'fe6e44ed-6e71-480a-bc9a-8669cb10da46',
      '2979665a-bfd3-4694-8e86-9516341fecb5',
    ],
  },
  {
    sheetName: 'B2b-DRUG-PLAN-iLeads',
    name: 'B2B Medical Concierge Drug Plan',
    manualColCount: 0,
    addressMapping: 'direct',
    emailTemplate: `Hi,
You may qualify for a Medical Concierge program covered by your insurance.
Reply if you're open to checking eligibility.
{{sendingAccountName}}`,
    campaignIds: [
      'efe3e886-f5a6-4e8e-a4bd-d9a092fe2322',
      'ebb59fda-6281-4416-958f-85b10eafab82',
    ],
  },
  {
    sheetName: 'ACA-DRUG-PLAN-iLeads',
    name: 'ACA Drug Plan',
    manualColCount: 0,
    addressMapping: 'direct',
    emailTemplate: `Hi {{firstName}}, ACA campaign...`,
    campaignIds: ['60517119-2c73-4cef-8cca-7b5ce42c9fe8'],
  },
];

// =======================
// Migration
// =======================
async function run() {
  const { MONGODB_URI, INSTANTLY_API_KEY, OPENAI_API_KEY, GOOGLE_SHEET_ID } = process.env;

  const missing = ['MONGODB_URI', 'INSTANTLY_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_SHEET_ID']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Load credentials.json
  const credentialsPath = join(__dirname, '..', 'credentials.json');
  let googleServiceAccountJson;

  try {
    googleServiceAccountJson = JSON.parse(await fs.readFile(credentialsPath, 'utf-8'));
  } catch {
    console.error('❌ Could not read credentials.json');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log('✓ Connected to MongoDB');

  // ── 1. Tenants ─────────────────────────────────────────

  const defaultTenant = await Tenant.findOneAndUpdate(
    { slug: 'lhpi-default' },
    {
      $set: {
        name: 'LHPI Default',
        googleSheetId: GOOGLE_SHEET_ID,
        credentials: {
          instantlyApiKey: INSTANTLY_API_KEY,
          openAiApiKey: OPENAI_API_KEY,
          googleServiceAccountJson,
        },
        isActive: true,
      },
      $setOnInsert: { slug: 'lhpi-default' },
    },
    { upsert: true, new: true }
  );

  const b2bTenant = await Tenant.findOneAndUpdate(
    { slug: 'lhpi-b2b' },
    {
      $set: {
        name: 'LHPI B2B',
        googleSheetId: GOOGLE_SHEET_ID,
        credentials: {
          instantlyApiKey: INSTANTLY_API_KEY,
          openAiApiKey: OPENAI_API_KEY,
          googleServiceAccountJson,
        },
        isActive: true,
      },
      $setOnInsert: { slug: 'lhpi-b2b' },
    },
    { upsert: true, new: true }
  );

  console.log(`✓ Tenants ready`);

  // ── 2. CampaignTypes + Campaigns ───────────────────────

  let totalCampaigns = 0;

  for (const entry of CAMPAIGN_DATA) {
    // 👇 ONLY change: route B2B to its own tenant
    const tenant =
      entry.sheetName === 'B2b-DRUG-PLAN-iLeads'
        ? b2bTenant
        : defaultTenant;

    const campaignType = await CampaignType.findOneAndUpdate(
      { tenant: tenant._id, sheetName: entry.sheetName },
      {
        $set: {
          name: entry.name,
          emailTemplate: entry.emailTemplate,
          manualColCount: entry.manualColCount,
          addressMapping: entry.addressMapping,
          isActive: true,
        },
        $setOnInsert: {
          tenant: tenant._id,
          sheetName: entry.sheetName,
        },
      },
      { upsert: true, new: true }
    );

    console.log(`  ✓ ${campaignType.name}`);

    for (const campaignId of entry.campaignIds) {
      await Campaign.findOneAndUpdate(
        { campaignId },
        {
          $set: {
            campaignType: campaignType._id,
            tenant: tenant._id,
            isActive: true,
          },
          $setOnInsert: { campaignId },
        },
        { upsert: true }
      );

      totalCampaigns++;
    }

    console.log(`     ${entry.campaignIds.length} campaign(s) upserted`);
  }

  console.log(`\n✅ Done — ${totalCampaigns} campaigns`);
  await mongoose.connection.close();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});