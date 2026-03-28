/**
 * Migration script — converts the hardcoded CAMPAIGN_SHEET_ROUTING into
 * the multi-tenant DB schema (Tenant → CampaignType → Campaign).
 *
 * Safe to run multiple times; uses upserts throughout.
 *
 * Usage:
 *   node scripts/migrate.js
 *
 * Requires a valid .env with MONGODB_URI, INSTANTLY_API_KEY, OPENAI_API_KEY,
 * GOOGLE_SHEET_ID, and credentials.json in the project root.
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
// Hardcoded campaign data (migrated from CAMPAIGN_SHEET_ROUTING)
// =======================
const CAMPAIGN_DATA = [
  {
    sheetName: 'senior-DRUG-PLAN_iLeads',
    name: 'Senior Free Phone & Drug Plan',
    manualColCount: 0,
    addressMapping: 'direct',
    emailTemplate: `Hi {{firstName}},
You may be eligible for three new programs designed to lower your monthly bills at zero cost to you:
* Telehealth Telecom: A free smartphone with reliable cellular service. This allows you to easily keep in touch with your doctors, access telehealth, and manage your healthcare needs.
* Free Drug Plan & Mail Order Pharmacy Benefits: Free, home-delivered prescription medications.
* Personal Care Coordination: Direct access to a dedicated health assistant for regular check-ins to help manage your health from home. We will schedule your telehealth appointments, handle your prescription refills, and deal with your insurance so you don't have to.
To see if you qualify to claim these benefits, simply reply to this email with the answers to these four quick questions:
1. What is the best phone number to contact you?
2. Who is your current health insurance provider?
3. Is your Medicare Advantage plan an HMO or a PPO?
4. Do you currently have Medicaid? (Yes or No)
That is it! Once you reply, our care team will review your coverage and give you a call to finalize your setup.
Warm regards,
{{sendingAccountName}}
If you do not need these benefits, just reply 'No thanks.'`,
    campaignIds: [
      'fe6e44ed-6e71-480a-bc9a-8669cb10da46',
      '2979665a-bfd3-4694-8e86-9516341fecb5',
      'b593d638-9872-49b9-b2ce-5eac66a374e2',
      'ac83afe2-aff6-4ee3-baf1-445eb5e2f095',
      'c28da471-a2d6-4c71-983e-51713be45226',
      '5e31cde7-cffa-402f-9360-03481cf0da92',
      'ab2f35c9-d28c-4418-a675-de8be186757b',
      'c5397601-3445-42be-9d06-996f8f17d96a',
      'c8f588b2-a00d-44a1-977c-dfe6925cf03e',
    ],
  },
  {
    sheetName: 'B2b-DRUG-PLAN-iLeads',
    name: 'B2B Medical Concierge Drug Plan',
    manualColCount: 0,
    addressMapping: 'direct',
    emailTemplate: `{{RANDOM | Hi | Hello | Hey}},
I'm reaching out because, {{RANDOM | based on | looking at}} the standard coverage at {{title}}, you {{RANDOM | likely | probably}} qualify for a new Medical Concierge program that is {{RANDOM | fully | 100%}} covered by your {{RANDOM | current | existing}} insurance.
We designed this as a "{{RANDOM | dedicated path | VIP path}}" for your {{RANDOM | personal | }} healthcare to {{RANDOM | eliminate | remove}} monthly costs while saving you time. The program {{RANDOM | includes | features}}:
* {{RANDOM | Discreet | Private}} Virtual Care: {{RANDOM | Instant | Direct}} access to specialists for 200+ conditions (weight loss, anxiety, etc.) on your own schedule.
* Next-Day Pharmacy: We {{RANDOM | manage | handle}} your prescriptions and ship them {{RANDOM | directly | right}} to your door the next morning.
* Included Connectivity: To {{RANDOM | ensure | guarantee}} you have a private, secure connection for your virtual visits, the program includes an unlimited mobile and data plan at no extra cost.
Are you {{RANDOM | open | receptive}} to a quick check to see if your {{RANDOM | specific | }} plan qualifies you for this?
{{RANDOM | Best | Regards | Cheers}},
{{sendingAccountName}} @ Vantage Health Concierge
{{RANDOM | If you don't need these services, just reply "no." | If you aren't interested, just reply "no thanks." | Just let me know if I should discontinue contact. | If this isn't a fit, feel free to just reply "pass." | Let me know if you'd rather not hear from us again.}}`,
    campaignIds: [
      'efe3e886-f5a6-4e8e-a4bd-d9a092fe2322',
      'ebb59fda-6281-4416-958f-85b10eafab82',
      '0860395a-9ac6-4789-a35e-a4da68a9823e',
      '03f2fa64-34f0-4ae6-96c7-356ae65a4a66',
      '2a7f2760-0905-43e6-aad4-9485eba84667',
      'e052f122-b362-41aa-8c1f-191596925111',
      '971fc59a-d873-4864-9785-78b3a388639b',
      '583436cc-1082-4713-b09d-80483dafe9df',
      'f7907451-3d60-426e-a055-ec471fad6b7d',
    ],
  },
  {
    sheetName: 'ACA-DRUG-PLAN-iLeads',
    name: 'ACA Drug Plan',
    manualColCount: 0,
    addressMapping: 'direct',
    emailTemplate: `Hi {{firstName}},
[ACA campaign email template — paste the full outbound email here]
{{sendingAccountName}}`,
    campaignIds: [
      '60517119-2c73-4cef-8cca-7b5ce42c9fe8',
    ],
  },
  {
    sheetName: 'Gova-Marketing-iLeads',
    name: 'Gova Marketing Outreach',
    manualColCount: 7,
    addressMapping: 'parse',
    emailTemplate: `{{RANDOM | Hi | Hello | Hey}} {{first_name}},

I'm reaching out to {{RANDOM | briefly introduce | share information about | quickly share}} our email sending services, in case you are {{RANDOM | looking | planning}} to run outbound campaigns.

We offer a {{RANDOM | complete | full}}, done-for-you service for $300 a month, which provides everything you need to {{RANDOM | safely send | successfully send}} up to 15,000 emails a month.

{{RANDOM | Alternatively | Or}}, if you just want to {{RANDOM | handle | manage | run}} your own email campaigns, we also provide the premium Microsoft SMTP infrastructure by itself to {{RANDOM | ensure | make sure}} your messages land in the primary inbox.

Are you currently running any cold email outreach at {{title}}?

{{RANDOM | Best | Regards | Cheers}},

{{sendingAccountName}}   @ Gova Marketing

P.S. We also sell {{RANDOM | targeted data | targeted lead lists | verified data}} for any industry you may need for your marketing.

{{RANDOM | If you don't need these services, just reply "no." | If you aren't interested, just reply "no thanks." | Just let me know if I should discontinue contact. | If this isn't a fit, feel free to just reply "pass." | Let me know if you'd rather not hear from us again.}}`,
    campaignIds: [
      '9a9782b9-c6d9-450e-8cd6-5f4f9df9fffd',
      'b0ec6743-a5d4-4d6c-b3b4-2498716c179f',
      '5be85ffb-0136-4c66-95ba-381430bdfabd',
      '3c4e0253-6414-470b-8b10-8ff4f76b9415',
      '7247cc9f-dd09-4f20-a0d2-1aa3225b7554',
      'af6dfd28-d56a-4952-bb36-64912b08f5c2',
      '2c5f4612-37ee-4e52-86bb-14abd2624d68',
      'e6c8b17a-e231-46df-bc83-a2610fe22507',
      '60e50909-3284-48a3-8bc3-995c7184119b',
      'ea84d5d5-9a6a-476b-9827-036284fd8b91',
      '57ac3047-d267-4039-81ed-5ae2a8215b14',
      '579e5301-6b33-460b-82cd-e2603806f4ed',
      '727a5541-3314-4f99-876a-4edf81b42a9d',
      '4f996b6b-52e1-45a8-ad01-8a4b9181855f',
      'abea1987-321b-4f6c-90b9-f973a9605bda',
      '47af20ee-eaba-4d02-885a-40845851d087',
      '2680cdf9-01b7-4615-8478-7a6783bf071f',
      'da030c03-ec09-4e6c-9599-8e20d8882dd4',
      'a0741a15-5fa0-4723-b31e-24a27137bead',
      '3eb874f8-a7de-49c6-b50d-c7252780fec1',
      '3cdc8e5f-975c-4a49-938a-41d051c6202a',
      '8cd2806e-3edb-43db-9642-a351fb115550',
      '448e87ca-2d9d-4a19-9298-35266890fa45',
      '04244315-40b8-4a5e-aee4-d932cc572af3',
      'f5d33dbd-5bd3-47f8-b69d-984b619d4014',
      'a9fd82d2-83cb-4be8-b53e-b1073bf7c239',
      '22dd2160-8080-424d-9dae-8a83a1f1b94e',
      '53c21abe-41df-4193-bd59-948ea5545b2d',
      '5b52fde0-3446-4dae-ada1-0ed1b503da7e',
      '7ffa159b-d1ae-4103-b27b-e0214844b71d',
      '9eab883e-3210-42cd-ab78-bc0ece8cc8b0',
      'a8ff7a2e-b746-4cec-9007-02a21f21a115',
      '1102a248-3c40-4a15-bd77-7221489b693c',
      'f8c33068-643e-4137-b193-eb392d5430ca',
      '0c1b3329-92a5-4ce3-a125-d066cd3559fd',
      'b2df33e8-e7c6-4b83-b702-af628137bc50',
      '8d3866f6-11ed-4df9-86f6-e2fe4299ad47',
      '5da659b5-e2fe-44ed-b7dc-1e1d9bb9974e',
      'b325005e-1212-403a-bb48-7deee5d059af',
      'dfd961df-ac26-4a27-93fc-134696bbf75f',
      '6881df7d-47f2-4898-a88d-68824e20f165',
      'a5edffc1-d83d-461c-aa97-300367c75275',
      '29281d5d-1db7-4f3f-98d0-d9db4926a2b6',
      '8b66eaf0-b880-4d6e-b2fe-13350cf1d119',
      '633527b6-96ee-4daf-ae48-d9fc21d2dcf1',
      '42a19b59-87d9-4c47-a67f-bbc6e5477992',
      '3ac306e2-a114-42a5-9bb2-ec73b07a5284',
    ],
  },
];

async function run() {
  const { MONGODB_URI, INSTANTLY_API_KEY, OPENAI_API_KEY, GOOGLE_SHEET_ID } = process.env;

  const missing = ['MONGODB_URI', 'INSTANTLY_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_SHEET_ID']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Load credentials.json (service account)
  const credentialsPath = join(__dirname, '..', 'credentials.json');
  let googleServiceAccountJson;
  try {
    googleServiceAccountJson = JSON.parse(await fs.readFile(credentialsPath, 'utf-8'));
  } catch {
    console.error('❌ Could not read credentials.json — make sure it exists in the project root.');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log('✓ Connected to MongoDB');

  // ── 1. Upsert the default Tenant ─────────────────────────────────────────
  const tenant = await Tenant.findOneAndUpdate(
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
  console.log(`✓ Tenant upserted: "${tenant.name}" (${tenant._id})`);

  // ── 2. Upsert CampaignTypes + Campaigns ──────────────────────────────────
  let totalCampaigns = 0;

  for (const entry of CAMPAIGN_DATA) {
    const campaignType = await CampaignType.findOneAndUpdate(
      { tenant: tenant._id, sheetName: entry.sheetName },
      {
        $set: {
          name:           entry.name,
          emailTemplate:  entry.emailTemplate,
          manualColCount: entry.manualColCount,
          addressMapping: entry.addressMapping,
          isActive:       true,
          // sheetHeaders not set here — model default is used on insert
        },
        $setOnInsert: {
          tenant: tenant._id,
          sheetName: entry.sheetName,
        },
      },
      { upsert: true, new: true }
    );
    console.log(`  ✓ CampaignType "${campaignType.name}" (${campaignType._id})`);

    for (const campaignId of entry.campaignIds) {
      await Campaign.findOneAndUpdate(
        { campaignId },
        {
          $set: {
            campaignType: campaignType._id,
            tenant:       tenant._id,
            isActive:     true,
          },
          $setOnInsert: { campaignId },
        },
        { upsert: true }
      );
      totalCampaigns++;
    }
    console.log(`     ${entry.campaignIds.length} campaign(s) upserted`);
  }

  console.log(`\n✅ Migration complete — ${CAMPAIGN_DATA.length} campaign type(s), ${totalCampaigns} campaign(s)`);
  await mongoose.connection.close();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
