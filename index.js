import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import chalk from 'chalk';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { getGoogleClients } from './services/googleClient.js';
import {
  hydrateRouteCache,
  getRouteForCampaign,
  getAllCampaignIds,
  getUniqueSheetTargets,
  getAllRoutes,
} from './services/routingService.js';
import Reply from './models/Reply.js';
import tenantRoutes from './routes/tenants.js';
import campaignTypeRoutes from './routes/campaignTypes.js';
import campaignRoutes from './routes/campaigns.js';

dotenv.config();

const app = express();
app.use(express.json());

// =======================
// Configuration
// =======================
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SCHEDULER_INTERVAL_MINUTES = parseInt(process.env.SCHEDULER_INTERVAL_MINUTES) || 1;
// Max tenants processed concurrently. 0 = unlimited (all tenants in parallel).
const TENANT_CONCURRENCY_LIMIT = parseInt(process.env.TENANT_CONCURRENCY_LIMIT) || 0;
const PHONE_LOOKUP_URL = process.env.PHONE_LOOKUP_URL || 'http://localhost:8000/lookup';

if (!MONGODB_URI) {
  console.error(chalk.red('❌ Missing required environment variable: MONGODB_URI'));
  process.exit(1);
}

// =======================
// Per-Tenant OpenAI Client Factory
// =======================
const openaiClients = new Map();

function getOpenAIClient(apiKey) {
  if (!openaiClients.has(apiKey)) {
    openaiClients.set(apiKey, new OpenAI({ apiKey }));
  }
  return openaiClients.get(apiKey);
}

// =======================
// Per-sheet email cache (deduplication)
// Keyed by `${googleSheetId}:${sheetName}` to avoid cross-tenant collisions.
// Call clearSheetEmailCache() after a route refresh so new campaigns get a
// fresh read on the next batch run.
// =======================
const sheetEmailCache = {};

function clearSheetEmailCache() {
  for (const k in sheetEmailCache) delete sheetEmailCache[k];
}

async function hydrateEmailCache(sheetKey, sheetName, googleSheetId, sheetsClient, manualColCount, headers) {
  if (sheetEmailCache[sheetKey]) return;
  sheetEmailCache[sheetKey] = new Set();

  try {
    const lastCol = columnLetter(manualColCount + headers.length);
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: googleSheetId,
      range: `${sheetName}!A1:${lastCol}`,
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) return;

    const headerRow = rows[0];
    const emailColIndex = headerRow.findIndex(h => h?.toLowerCase().trim() === 'lead email');
    if (emailColIndex === -1) return;

    for (let i = 1; i < rows.length; i++) {
      const email = rows[i][emailColIndex];
      if (email) sheetEmailCache[sheetKey].add(email.toLowerCase().trim());
    }

    console.log(chalk.gray(`   [Cache] "${sheetName}" — loaded ${sheetEmailCache[sheetKey].size} known emails`));
  } catch (err) {
    console.error(chalk.yellow(`⚠️ Could not hydrate email cache for "${sheetName}": ${err.message}`));
  }
}

function isEmailInCache(sheetKey, email) {
  if (!email) return false;
  const cache = sheetEmailCache[sheetKey];
  return cache ? cache.has(email.toLowerCase().trim()) : false;
}

function addEmailToCache(sheetKey, email) {
  if (!email) return;
  if (!sheetEmailCache[sheetKey]) sheetEmailCache[sheetKey] = new Set();
  sheetEmailCache[sheetKey].add(email.toLowerCase().trim());
}

// =======================
// Rate Limiting
// =======================
const RATE_LIMIT_MS = 1000;
let lastRequestTime = 0;

async function awaitRateLimit() {
  const now = Date.now();
  const diff = now - lastRequestTime;
  if (diff < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - diff));
  }
  lastRequestTime = Date.now();
}

// =======================
// Retry Helper
// =======================
async function withRetry(fn, label, maxAttempts = 3, baseDelayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxAttempts;
      const delay = baseDelayMs * attempt + Math.random() * 1000;
      console.error(chalk.yellow(`⚠️ ${label} failed (attempt ${attempt}/${maxAttempts}): ${err.message}`));
      if (isLast) {
        console.error(chalk.red(`❌ ${label} exhausted all retries.`));
        throw err;
      }
      console.log(chalk.gray(`   Retrying in ${(delay / 1000).toFixed(1)}s...`));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// =======================
// MongoDB Connection
// =======================
async function connectMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log(chalk.green('✓ MongoDB connected'));
  } catch (err) {
    console.error(chalk.red('MongoDB connection failed'), err);
    process.exit(1);
  }
}

// =======================
// Instantly API — Fetch Lead Data
// =======================
async function fetchLeadDataFromInstantly(leadEmail, instantlyApiKey) {
  console.log(`⏳ Fetching lead data from Instantly for: ${leadEmail}`);
  await awaitRateLimit();

  return withRetry(async () => {
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

    if (res.data?.items?.length) {
      const lead = res.data.items[0];
      console.log("lead------------------!!!");
      console.log(lead);
      console.log(`✅ Lead data fetched for ${leadEmail}`);
      console.log(`   - Name: ${lead.first_name || ''} ${lead.last_name || ''}`);
      console.log(`   - Phone: ${lead.payload?.phone_number || 'N/A'}`);

      const structuredAddress = lead.payload?.formatted_address ||
        `${lead.payload?.address_line1 || ''} ${lead.payload?.address_line2 || ''}`.trim();
      const rawAddressString = lead.payload?.address || '';

      return {
        ...lead,
        phone_number: lead.payload?.phone_number || lead.payload?.phone || lead?.phone,
        additional_phones: lead.payload?.additional_phone_numbers,
        address: structuredAddress,
        city: lead.payload?.city,
        state: lead.payload?.state_code,
        zip: lead.payload?.zip_code,
        raw_address_string: rawAddressString || structuredAddress,
        title: lead.payload?.title,
        linkedin: lead.payload?.linkedin_url,
        full_payload: lead.payload,
      };
    }

    console.log(`⚠️ No lead data found in Instantly for ${leadEmail}`);
    return null;
  }, `Instantly fetch (${leadEmail})`);
}

// =======================
// Website Phone Lookup — http://localhost:8000/lookup
// Returns the first N phone_numbers from the local scraper service.
// Falls back gracefully on timeout or error — never blocks processing.
// =======================
async function fetchWebsitePhones(leadEmail) {
  try {
    console.log(`📞 Fetching website phones for: ${leadEmail}`);
    const res = await axios.post(
      PHONE_LOOKUP_URL,
      { email: leadEmail },
      { timeout: 180000, headers: { 'Content-Type': 'application/json' } }
    );

    const phones = res.data?.phone_numbers || [];
    if (res.data?.skipped) {
      console.log(chalk.gray(`   [Phone Lookup] Skipped: ${res.data.skip_reason || 'unknown reason'}`));
      return [];
    }
    console.log(chalk.gray(`   [Phone Lookup] Found ${phones.length} number(s)`));
    return phones;
  } catch (err) {
    console.warn(chalk.yellow(`⚠️ Website phone lookup failed for ${leadEmail}: ${err.message}`));
    return [];
  }
}

// =======================
// Step 1 — Analyze Reply Interest & Extract Eligibility Answers
// =======================
async function analyzeReplyEligibility(replyText, replySubject, campaignContext = {}, openaiClient) {
  const {
    campaignType = 'General Outreach',
    emailTemplate = '[Original email template not available]',
  } = campaignContext;

  console.log(`🔍 Analyzing reply — campaign: ${campaignType}`);

  const prompt = `You are an expert sales analyst working across multiple industries. You will analyze a reply to a cold outbound email and determine the lead's interest level and eligibility.

Your analysis must be derived entirely from the original email — not from any assumed industry norms. You work for many different types of businesses and must adapt your reasoning to each campaign.

Note: {{RANDOM | option1 | option2}} or {{RANDOM | A | B | C}} placeholders in the email mean one random variant was sent — treat all variants as equivalent.

═══════════════════════════════════
STEP 1 — UNDERSTAND THIS CAMPAIGN
═══════════════════════════════════
Read the original outbound email below and extract:

A. WHAT IS BEING OFFERED — summarize the core offer in 1–2 sentences.
B. QUALIFYING QUESTIONS — list every question or piece of information the email explicitly asks the lead for.
C. INTEREST SIGNALS — based on this specific offer, what would a genuinely interested reply look like? (e.g., answering questions asked, providing requested info, asking follow-up questions about the offer)
D. DISINTEREST / DISQUALIFICATION SIGNALS — what would clearly indicate the lead is not interested or does not qualify? (e.g., explicit opt-out language, confirming they lack a required qualification stated in the email)

--- ORIGINAL EMAIL (Campaign: ${campaignType}) ---
${emailTemplate}
--- END OF EMAIL ---

═══════════════════════════════════
STEP 2 — EVALUATE THE REPLY
═══════════════════════════════════
Now evaluate the lead's reply using the campaign understanding from Step 1.

REPLY SUBJECT: ${replySubject}

LEAD'S REPLY:
${replyText}

INTEREST LEVEL — choose one based on the campaign criteria you extracted:
- "high"   : Lead answered one or more qualifying questions, provided requested information, shared their situation, asked specific follow-up questions about the offer, or expressed clear readiness to move forward.
- "medium" : Lead showed curiosity or partial engagement — asked a vague question about the offer, gave a non-committal positive, or provided incomplete answers.
- "low"    : Lead acknowledged the email but made no commitment and provided nothing useful (e.g., "I'll think about it", "send me more info" with no other context).
- "none"   : Lead explicitly opted out ("no", "not interested", "remove me", "unsubscribe", "stop", "do not contact", "pass", "discontinue"), OR confirmed they definitively lack a qualification the email required.

ELIGIBILITY — based solely on what qualifies someone according to this email:
- "Likely Eligible"      : Lead confirmed or strongly implied they meet the qualifying criteria for this offer.
- "Likely Ineligible"    : Lead explicitly confirmed they do NOT meet a required qualification.
- "Needs Verification"   : Insufficient information to determine — partial answers, unclear, or no eligibility details given.

QUALIFYING SIGNALS — list every fact the lead shared that is directly relevant to the offer or qualifying criteria (answers to questions asked, details about their situation, company info, coverage, tools they use, etc.). If none, return [].

PHONE NUMBER — extract any phone number from the reply text. Format: (XXX) XXX-XXXX. Return null if absent.

FOR SCHEDULING — return "Yes" only if the lead explicitly mentions calling, scheduling, sharing availability, or requests to be contacted. Otherwise "No".

OUTPUT — return ONLY valid JSON, no other text:
{
  "campaignSummary": {
    "offer": "what is being offered",
    "qualifyingQuestions": ["questions the email asked"],
    "interestSignals": ["what interest looks like for this campaign"],
    "disqualifyingSignals": ["what disinterest/ineligibility looks like"]
  },
  "isInterested": true | false,
  "interestLevel": "high" | "medium" | "low" | "none",
  "reasoning": "1–2 sentences referencing the specific offer and what the lead said",
  "keyPhrases": ["exact phrases from the reply that drove the decision"],
  "phoneFromReply": "(XXX) XXX-XXXX" | null,
  "qualifyingSignals": ["facts the lead shared relevant to this offer"],
  "overallEligibility": "Likely Eligible" | "Likely Ineligible" | "Needs Verification",
  "forScheduling": "Yes" | "No"
}`;

  return withRetry(async () => {
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a lead qualification analyst for outbound sales campaigns across multiple industries. You have no assumed domain — every decision you make is derived from reading the original email template. Campaign: "${campaignType}".`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    console.log(`📊 Interest Level: ${analysis.interestLevel.toUpperCase()}`);
    console.log(`   Is Interested: ${analysis.isInterested ? '✅ YES' : '❌ NO'}`);
    console.log(`   Eligibility: ${analysis.overallEligibility}`);
    console.log(`   Offer understood: ${analysis.campaignSummary?.offer || '—'}`);
    console.log(`   Phone from Reply: ${analysis.phoneFromReply || 'None found'}`);
    console.log(`   For Scheduling: ${analysis.forScheduling}`);
    if (analysis.qualifyingSignals?.length) {
      console.log(`   Qualifying Signals: ${analysis.qualifyingSignals.join(' | ')}`);
    }
    console.log(`   Reasoning: ${analysis.reasoning}`);

    return analysis;
  }, 'OpenAI eligibility analysis');
}

// =======================
// Step 2 — Full Lead Enrichment with OpenAI
// =======================
async function enrichLeadWithOpenAI(replyData, instantlyData, eligibilityAnalysis, addressMapping = 'direct', openaiClient, campaignContext = {}) {
  console.log('🤖 Enriching lead record with OpenAI...');

  const sheetHeaders = campaignContext.sheetHeaders || [];
  const headerSet = new Set(sheetHeaders);

  const instantlyContext = instantlyData ? {
    first_name: instantlyData.first_name || instantlyData.payload?.firstName,
    last_name: instantlyData.last_name || instantlyData.payload?.lastName,
    phone_number: instantlyData.phone_number,
    additional_phones: instantlyData.additional_phones,
    address: instantlyData.address,
    city: instantlyData.city,
    state: instantlyData.state,
    zip: instantlyData.zip,
    raw_address_string: instantlyData.raw_address_string,
    title: instantlyData.title,
    linkedin: instantlyData.linkedin,
  } : null;

  // Address field instructions — shared across the 4 location headers.
  const addrNote = addressMapping === 'skip'
    ? 'Leave blank — address population is disabled for this campaign.'
    : addressMapping === 'parse'
    ? `Parse from the combined Instantly address string: "${instantlyContext?.raw_address_string || ''}". Extract only the relevant part (street / city / 2-letter state / 5-digit zip). Leave blank if unparseable.`
    : 'Use the corresponding Instantly field (address / city / state_code / zip_code). Leave blank if not available.';

  // Rules for every well-known column name.
  // Only rules whose header exists in sheetHeaders are included in the prompt.
  const qualifyingNote = eligibilityAnalysis.qualifyingSignals?.length
    ? ` Also include from qualifyingSignals: ${eligibilityAnalysis.qualifyingSignals.join(', ')}.`
    : '';

  const FIELD_RULES = {
    'Date':                   `Today's date: ${new Date().toISOString().split('T')[0]}`,
    'Hot Lead':               'eligibilityAnalysis.interestLevel — one of: high / medium / low / none',
    'For Scheduling':         'eligibilityAnalysis.forScheduling — "Yes" or "No"',
    'Sales Person':           'Convert email_account to full name (e.g. "sandra.nguyen@domain.com" → "Sandra Nguyen")',
    'Sales Person Email':     'email_account from reply data',
    'Lead First Name':        'Instantly first_name, or parse from display_name',
    'Lead Last Name':         'Instantly last_name, or parse from display_name',
    'Lead Email':             'lead_email from reply data',
    'Phone From Reply':       'eligibilityAnalysis.phoneFromReply — format (XXX) XXX-XXXX, or blank',
    'Phone From Instantly':   'Instantly phone_number — format (XXX) XXX-XXXX, or blank',
    'Phone 2':                'Instantly additional_phones[0] — format (XXX) XXX-XXXX, or blank',
    'Phone 3':                'Instantly additional_phones[1] — format (XXX) XXX-XXXX, or blank',
    'Phone 1':                'Leave blank — filled by website phone lookup after enrichment',
    'Overall Eligibility':    'eligibilityAnalysis.overallEligibility',
    'Reply Text':             'The COMPLETE reply_text_snippet — do NOT truncate',
    'Email Signature':        'Extract from reply: text after "Sincerely," / "Best," / "Thanks," / "Warm regards," or a name + phone block at the bottom',
    'Address':                addrNote,
    'City':                   addrNote,
    'State':                  addrNote,
    'Zip':                    addrNote,
    'LinkedIn':               'Instantly linkedin field, or blank',
    'Details':                `Any useful context (title, job, company, campaign name, extra notes from reply).${qualifyingNote}`,
    'Campaign Name':          'campaign_name from reply data',
    '@dropdown':              'Leave empty',
  };

  // Build numbered instructions only for fields present in this sheet.
  const knownInstructions = sheetHeaders
    .filter(h => FIELD_RULES[h])
    .map((h, i) => `  ${i + 1}. "${h}": ${FIELD_RULES[h]}`)
    .join('\n');

  // Columns not in FIELD_RULES — the AI infers values from reply text,
  // qualifyingSignals, and Instantly data. This includes campaign-specific
  // fields like "Insurance Provider", "Medicare Advantage", "Medicaid", etc.
  // that only exist on certain sheets and should not be assumed for all campaigns.
  const unknownHeaders = sheetHeaders.filter(h => !FIELD_RULES[h]);
  const unknownNote = unknownHeaders.length
    ? `\nFor these campaign-specific columns, extract the value directly from the reply text or eligibility analysis qualifyingSignals. Leave blank if not mentioned:\n${unknownHeaders.map(h => `  - "${h}"`).join('\n')}`
    : '';

  // Generate the exact JSON shape the AI must return — keyed by actual sheet headers.
  const jsonShape = JSON.stringify(
    { enrichedLead: Object.fromEntries(sheetHeaders.map(h => [h, '...'])), reasoning: '...' },
    null, 2
  );

  const prompt = `You are a lead enrichment AI. Build a complete lead record from the data below.
Campaign type: ${campaignContext?.campaignType || 'General Outreach'}

REPLY DATA:
${JSON.stringify({
    campaign_name: replyData.campaign_name,
    lead_email: replyData.lead_email,
    email_account: replyData.email_account,
    display_name: replyData.display_name,
    reply_subject: replyData.reply_subject,
    reply_text_snippet: replyData.reply_text_snippet || replyData.reply_text || '',
  }, null, 2)}

ELIGIBILITY ANALYSIS (already completed):
${JSON.stringify(eligibilityAnalysis, null, 2)}

INSTANTLY LEAD DATA:
${instantlyContext ? JSON.stringify(instantlyContext, null, 2) : 'Not available'}

FIELD MAPPING INSTRUCTIONS — fill every key in the output JSON using these rules:
${knownInstructions}${unknownNote}

Return ONLY valid JSON matching this exact shape (one key per sheet column, no extras, no omissions):
${jsonShape}`;

  return withRetry(async () => {
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a precise data extraction AI for outbound sales campaigns across multiple industries. Extract and map lead data accurately. Return only valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content);
    console.log('✅ OpenAI enrichment complete');
    console.log('📝 Reasoning:', result.reasoning);
    return result.enrichedLead;
  }, 'OpenAI lead enrichment');
}

// =======================
// Fallback Lead Data
// Builds a best-effort row from whatever data is available, keyed by the
// actual sheetHeaders so it works for any campaign type.
// =======================
function createFallbackLeadData(replyData, eligibilityAnalysis, instantlyData = null, addressMapping = 'direct', sheetHeaders = []) {
  console.log(chalk.yellow('⚠️ Creating fallback lead data...'));

  const address = addressMapping === 'skip' || !instantlyData ? '' :
    addressMapping === 'parse' ? (instantlyData.raw_address_string || '') :
    (instantlyData.address || '');
  const city  = addressMapping === 'direct' ? (instantlyData?.city  || '') : '';
  const state = addressMapping === 'direct' ? (instantlyData?.state || '') : '';
  const zip   = addressMapping === 'direct' ? (instantlyData?.zip   || '') : '';

  // Known universal field values — covers the standard 27-column default schema.
  const knownValues = {
    'Date':                   new Date().toISOString().split('T')[0],
    'Hot Lead':               eligibilityAnalysis?.interestLevel || '',
    'For Scheduling':         eligibilityAnalysis?.forScheduling || '',
    'Sales Person':           replyData.email_account?.split('@')[0]?.replace('.', ' ') || '',
    'Sales Person Email':     replyData.email_account || '',
    'Lead First Name':        '',
    'Lead Last Name':         '',
    'Lead Email':             replyData.lead_email || '',
    'Phone From Reply':       eligibilityAnalysis?.phoneFromReply || '',
    'Phone From Instantly':   '',
    'Phone 1':                '',
    'Phone 2':                '',
    'Phone 3':                '',
    'Overall Eligibility':    eligibilityAnalysis?.overallEligibility || 'Needs Verification',
    'Reply Text':             replyData.reply_text_snippet || '',
    'Email Signature':        '',
    'Address':                address,
    'City':                   city,
    'State':                  state,
    'Zip':                    zip,
    'LinkedIn':               '',
    'Details':                '',
    'Campaign Name':          replyData.campaign_name || '',
    '@dropdown':              '',
  };

  // If sheetHeaders provided, return only those keys (blanking unknowns).
  if (sheetHeaders.length) {
    return Object.fromEntries(sheetHeaders.map(h => [h, knownValues[h] ?? '']));
  }

  return knownValues;
}

// =======================
// Google Sheets — Column Letter Helper
// =======================
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

// =======================
// Google Sheets — Ensure Sheet Tab & Headers Exist
// =======================
async function ensureSheetExists(sheetName, manualColCount, headers, sheetsClient, googleSheetId) {
  const startCol = columnLetter(manualColCount + 1);
  const lastCol  = columnLetter(manualColCount + headers.length);

  const res = await sheetsClient.spreadsheets.get({ spreadsheetId: googleSheetId });
  const sheetExists = res.data.sheets.some(s => s.properties.title === sheetName);

  if (!sheetExists) {
    console.log(chalk.yellow(`Creating new sheet tab: "${sheetName}"`));
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: googleSheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    console.log(chalk.green(`✓ Sheet tab created: "${sheetName}"`));
  }

  // Read the full header row from startCol rightward — no fixed end column —
  // so we can detect stale columns that extend beyond the current header list.
  const headerCheckRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: googleSheetId,
    range: `${sheetName}!${startCol}1:1`,
  });

  const existingHeaders = headerCheckRes.data.values?.[0] || [];
  const headersMatch = existingHeaders.length === headers.length &&
    headers.every((h, i) => existingHeaders[i] === h);

  if (!headersMatch) {
    // If the existing header row is wider than our new list, clear the stale
    // columns first so they don't linger as orphaned headers.
    if (existingHeaders.length > headers.length) {
      const staleStartCol = columnLetter(manualColCount + headers.length + 1);
      const staleEndCol   = columnLetter(manualColCount + existingHeaders.length);
      console.log(chalk.yellow(`Clearing stale headers ${staleStartCol}–${staleEndCol} in "${sheetName}"`));
      await sheetsClient.spreadsheets.values.clear({
        spreadsheetId: googleSheetId,
        range: `${sheetName}!${staleStartCol}1:${staleEndCol}1`,
      });
    }

    console.log(chalk.yellow(`Writing automation headers to ${sheetName}!${startCol}1:${lastCol}1`));
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: googleSheetId,
      range: `${sheetName}!${startCol}1:${lastCol}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
    console.log(chalk.green(`✓ Headers written: ${startCol}–${lastCol} in "${sheetName}"`));
  } else {
    console.log(chalk.gray(`   [Headers OK] "${sheetName}" ${startCol}–${lastCol}`));
  }
}

// =======================
// Google Sheets — Append Row
// =======================
async function appendToSheet(sheetName, enrichedData, manualColCount, headers, sheetsClient, googleSheetId) {
  const startCol = columnLetter(manualColCount + 1);
  const lastCol  = columnLetter(manualColCount + headers.length);

  const rowArray = headers.map((header, index) => {
    const value = enrichedData[header];
    const finalValue = value !== undefined && value !== null ? String(value) : '';
    if (finalValue) {
      const colLabel = columnLetter(manualColCount + 1 + index);
      console.log(chalk.gray(`   [${colLabel}] "${header}" => "${finalValue.substring(0, 80)}"`));
    }
    return finalValue;
  });

  console.log(chalk.blue('\n📏 Row summary:'));
  console.log(chalk.gray(`   Total columns: ${rowArray.length} (${startCol}–${lastCol})`));
  console.log(chalk.gray(`   Non-empty values: ${rowArray.filter(v => v !== '').length}`));

  return withRetry(async () => {
    // Scan full width (A → lastCol) so the new row aligns with manual data rows.
    const fullRangeRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: googleSheetId,
      range: `${sheetName}!A:${lastCol}`,
    });
    const allRows = fullRangeRes.data.values || [];
    const nextRow = allRows.length + 1;

    const targetRange = `${sheetName}!${startCol}${nextRow}:${lastCol}${nextRow}`;

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: googleSheetId,
      range: targetRange,
      valueInputOption: 'RAW',
      requestBody: { values: [rowArray] },
    });
    console.log(chalk.green(`✅ Row ${nextRow} written to "${sheetName}" (${startCol}–${lastCol})\n`));
    return true;
  }, `Sheet append (${sheetName})`);
}

// =======================
// Instantly — Update Lead Interest Status
// =======================
async function updateInstantlyInterest(leadEmail, instantlyApiKey, interestValue = 56) {
  if (!leadEmail) return false;
  try {
    await axios.post(
      'https://api.instantly.ai/api/v2/leads/update-interest-status',
      { lead_email: leadEmail, interest_value: interestValue, disable_auto_interest: true },
      {
        headers: {
          Authorization: `Bearer ${instantlyApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    console.log(`✅ Updated Instantly interest for: ${leadEmail}`);
    return true;
  } catch (error) {
    console.error(`❌ Instantly interest update failed for ${leadEmail}:`, error.response?.data || error.message);
    return false;
  }
}

// =======================
// Main Processing Function — Single Reply
// =======================
// Per-tenant locks — each tenant's replies run sequentially but tenants run
// concurrently. JS is single-threaded so Set access is safe.
const tenantProcessingLocks = new Set();

async function processReply(reply) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(chalk.blue(`Processing Reply: ${reply.lead_email}`));

  const leadEmail = reply.lead_email;

  if (!leadEmail || !leadEmail.includes('@')) {
    console.log(chalk.yellow('⏭️ Skipping — no valid email found'));
    return false;
  }

  const route = getRouteForCampaign(reply.campaign_id);
  if (!route) {
    console.log(chalk.yellow(`⏭️ Skipping — campaign ${reply.campaign_id} has no sheet assignment`));
    return false;
  }

  const {
    sheetName,
    campaignType,
    emailTemplate,
    sheetHeaders,
    manualColCount,
    addressMapping,
    googleSheetId,
    tenantCredentials,
    tenantSettings,
  } = route;

  const sheetKey     = `${googleSheetId}:${sheetName}`;
  const openaiClient = getOpenAIClient(tenantCredentials.openAiApiKey);
  const instantlyApiKey = tenantCredentials.instantlyApiKey;
  const { sheets }   = await getGoogleClients(tenantCredentials.googleServiceAccountJson);

  console.log(chalk.cyan(`   → Target sheet: "${sheetName}" [${campaignType}]`));
  console.log('='.repeat(60));

  try {
    // Step 0: Pre-flight duplicate check (fast in-memory cache)
    if (isEmailInCache(sheetKey, leadEmail)) {
      console.log(chalk.yellow(`⏭️ Skipping — already in sheet "${sheetName}": ${leadEmail}`));
      await Reply.updateOne({ _id: reply._id }, { $set: { isProcessed: true } });
      return false;
    }

    // Step 1: Analyze reply
    const eligibilityAnalysis = await analyzeReplyEligibility(
      reply.reply_text_snippet || reply.reply_text || '',
      reply.reply_subject || '',
      { campaignType, emailTemplate },
      openaiClient
    );

    // Step 2: Skip if no interest
    if (!eligibilityAnalysis.isInterested) {
      console.log(chalk.yellow('⏭️ Skipping — no interest detected'));
      console.log(chalk.gray(`   Reason: ${eligibilityAnalysis.reasoning}`));
      await Reply.updateOne({ _id: reply._id }, { $set: { isProcessed: true } });
      return false;
    }

    console.log(chalk.green('✅ Lead engaged — proceeding with enrichment'));

    // Step 3: Fetch from Instantly + website phone lookup (in parallel)
    const [instantlyData, websitePhones] = await Promise.all([
      fetchLeadDataFromInstantly(leadEmail, instantlyApiKey),
      fetchWebsitePhones(leadEmail),
    ]);

    // Step 4: Enrich
    let enrichedData;
    try {
      enrichedData = await enrichLeadWithOpenAI(reply, instantlyData, eligibilityAnalysis, addressMapping, openaiClient, { campaignType, sheetHeaders });
    } catch (err) {
      console.error(chalk.yellow('⚠️ OpenAI enrichment failed — using fallback data'));
      enrichedData = createFallbackLeadData(reply, eligibilityAnalysis, instantlyData, addressMapping, sheetHeaders);
    }

    // Overwrite Phone 1/2/3 with website lookup results (always deterministic).
    if (sheetHeaders.includes('Phone 1')) enrichedData['Phone 1'] = websitePhones[0]?.number || '';
    if (sheetHeaders.includes('Phone 2')) enrichedData['Phone 2'] = websitePhones[1]?.number || '';
    if (sheetHeaders.includes('Phone 3')) enrichedData['Phone 3'] = websitePhones[2]?.number || '';

    // Step 5: Race-condition duplicate guard
    if (isEmailInCache(sheetKey, leadEmail)) {
      console.log(chalk.yellow(`⏭️ Skipping — duplicate detected just before write: ${leadEmail}`));
      await Reply.updateOne({ _id: reply._id }, { $set: { isProcessed: true } });
      return false;
    }

    // Step 6: Write to Google Sheet
    const appended = await appendToSheet(sheetName, enrichedData, manualColCount, sheetHeaders, sheets, googleSheetId);

    if (appended) {
      addEmailToCache(sheetKey, leadEmail);
      await Reply.updateOne({ _id: reply._id }, { $set: { isProcessed: true } });
      await updateInstantlyInterest(leadEmail, instantlyApiKey, 56);
      console.log(chalk.green(`✅ Reply fully processed: ${leadEmail} → "${sheetName}"`));
      return true;
    } else {
      console.log(chalk.red(`⚠️ Sheet write failed — not marking as processed: ${leadEmail}`));
      return false;
    }
  } catch (error) {
    console.error(chalk.red(`❌ Unexpected error processing ${leadEmail}:`), error.message);
    return false;
  }
}

// =======================
// Per-Tenant Processor
// Handles sheet setup + sequential reply processing for one tenant in isolation.
// Errors in one tenant never affect others.
// =======================
async function processTenant(tenantName, sheetEntries, tenantReplies) {
  if (tenantProcessingLocks.has(tenantName)) {
    console.log(chalk.yellow(`⏭️ [${tenantName}] Skipping — already processing`));
    return;
  }

  tenantProcessingLocks.add(tenantName);
  const tag = chalk.magenta(`[${tenantName}]`);

  try {
    console.log(chalk.blue(`\n${tag} Starting — ${tenantReplies.length} reply(ies) across ${sheetEntries.length} sheet(s)`));

    // Setup: each sheet target is independent — run in parallel to cut latency.
    await Promise.all(sheetEntries.map(async ([sheetKey, route]) => {
      const { sheets } = await getGoogleClients(route.tenantCredentials.googleServiceAccountJson);
      await ensureSheetExists(
        route.sheetName, route.manualColCount, route.sheetHeaders, sheets, route.googleSheetId,
        { tenantName: route.tenantName, campaignType: route.campaignType }
      );
      await hydrateEmailCache(sheetKey, route.sheetName, route.googleSheetId, sheets, route.manualColCount, route.sheetHeaders);
    }));

    if (tenantReplies.length === 0) {
      console.log(chalk.gray(`${tag} 📭 No unprocessed replies`));
      return;
    }

    let successCount = 0;
    let skipCount = 0;

    for (let i = 0; i < tenantReplies.length; i++) {
      const reply = tenantReplies[i];
      const route = getRouteForCampaign(reply.campaign_id);
      const targetLabel = route ? `"${route.sheetName}"` : 'unrouted';

      console.log(chalk.cyan(`\n${tag} [${i + 1}/${tenantReplies.length}] ${reply.lead_email} → ${targetLabel}`));
      console.log(chalk.gray(`   Campaign: ${reply.campaign_id}`));

      const success = await processReply(reply);

      if (success) {
        successCount++;
        if (i < tenantReplies.length - 1) {
          const settings = route?.tenantSettings || {};
          const delay = (settings.successDelayMs ?? 10000) + Math.floor(Math.random() * (settings.leadDelayJitterMs ?? 3000));
          console.log(chalk.gray(`${tag} ⏳ Waiting ${(delay / 1000).toFixed(1)}s before next lead...`));
          await new Promise(r => setTimeout(r, delay));
        }
      } else {
        skipCount++;
      }
    }

    console.log(chalk.green(`${tag} ✅ Complete — Processed: ${successCount} | Skipped: ${skipCount}\n`));
  } catch (err) {
    console.error(chalk.red(`${tag} ❌ Error:`), err.message);
  } finally {
    tenantProcessingLocks.delete(tenantName);
  }
}

// =======================
// Batch Coordinator — Groups replies by tenant, runs tenants concurrently
// =======================
// Runs up to TENANT_CONCURRENCY_LIMIT tenants at a time (0 = all in parallel).
async function runConcurrently(fns, limit) {
  if (!limit || limit >= fns.length) return Promise.allSettled(fns.map(f => f()));
  const results = [];
  for (let i = 0; i < fns.length; i += limit) {
    const settled = await Promise.allSettled(fns.slice(i, i + limit).map(f => f()));
    results.push(...settled);
  }
  return results;
}

let isBatchRunning = false;

async function processUnprocessedReplies() {
  if (isBatchRunning) {
    console.log(chalk.yellow('⏭️ Skipping run — batch coordination already in progress'));
    return;
  }

  isBatchRunning = true;

  try {
    // Refresh route cache on every run so newly added tenants, campaign types,
    // campaigns, and Google sheets are picked up without a server restart.
    await hydrateRouteCache();

    const allCampaignIds = getAllCampaignIds();
    if (allCampaignIds.size === 0) {
      console.log(chalk.yellow('⚠️ Route cache is empty — run /refresh-routes or check the DB'));
      return;
    }

    // Group sheet targets by tenant.
    const sheetsByTenant = new Map(); // tenantName → [[sheetKey, route], ...]
    for (const [sheetKey, route] of getUniqueSheetTargets()) {
      if (!sheetsByTenant.has(route.tenantName)) sheetsByTenant.set(route.tenantName, []);
      sheetsByTenant.get(route.tenantName).push([sheetKey, route]);
    }

    // Fetch all unprocessed replies and group by tenant.
    const replies = await Reply.find({
      isProcessed: false,
      campaign_id: { $in: [...allCampaignIds] },
    }).sort({ createdAt: 1 });

    if (replies.length === 0) {
      console.log(chalk.gray('\n📭 No unprocessed replies found\n'));
      return;
    }

    const repliesByTenant = new Map(); // tenantName → reply[]
    for (const reply of replies) {
      const route = getRouteForCampaign(reply.campaign_id);
      if (!route) continue;
      if (!repliesByTenant.has(route.tenantName)) repliesByTenant.set(route.tenantName, []);
      repliesByTenant.get(route.tenantName).push(reply);
    }

    const tenantNames = [...new Set([...sheetsByTenant.keys(), ...repliesByTenant.keys()])];
    console.log(chalk.blue(`\n📬 ${replies.length} reply(ies) across ${tenantNames.length} tenant(s)\n`));
    for (const name of tenantNames) {
      const count = repliesByTenant.get(name)?.length ?? 0;
      console.log(chalk.gray(`   ${chalk.magenta(`[${name}]`)} ${count} reply(ies)`));
    }

    await runConcurrently(
      tenantNames.map(name => () =>
        processTenant(
          name,
          sheetsByTenant.get(name) || [],
          repliesByTenant.get(name) || []
        )
      ),
      TENANT_CONCURRENCY_LIMIT
    );
  } catch (err) {
    console.error(chalk.red('Error in processUnprocessedReplies:'), err);
  } finally {
    isBatchRunning = false;
  }
}

// =======================
// Management API Routes
// =======================
app.use('/api/tenants', tenantRoutes);
app.use('/api/campaign-types', campaignTypeRoutes);
app.use('/api/campaigns', campaignRoutes);

// =======================
// Operational Routes
// =======================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Multi-Tenant Lead Enrichment System',
    config: {
      totalCampaigns: getAllCampaignIds().size,
      totalSheets: getUniqueSheetTargets().size,
      schedulerIntervalMinutes: SCHEDULER_INTERVAL_MINUTES,
      deduplication: 'enabled (in-memory cache)',
      retryLogic: 'enabled',
    },
  });
});

app.get('/routing', (req, res) => {
  const routes = getAllRoutes();
  const bySheet = {};

  for (const [campaignId, route] of routes) {
    const key = `${route.googleSheetId}:${route.sheetName}`;
    if (!bySheet[key]) {
      bySheet[key] = {
        sheetName: route.sheetName,
        campaignType: route.campaignType,
        googleSheetId: route.googleSheetId,
        manualColCount: route.manualColCount,
        automationStartsAt: columnLetter(route.manualColCount + 1),
        addressMapping: route.addressMapping,
        headerCount: route.sheetHeaders.length,
        campaignIds: [],
      };
    }
    bySheet[key].campaignIds.push(campaignId);
  }

  res.json({
    totalCampaigns: routes.size,
    totalSheets: Object.keys(bySheet).length,
    routing: Object.values(bySheet),
  });
});

app.post('/process-now', async (req, res) => {
  if (isBatchRunning) {
    return res.status(429).json({ error: 'Batch coordination already running', status: 'busy' });
  }
  res.json({ message: 'Processing started', status: 'running' });
  processUnprocessedReplies();
});

// Reload route cache from DB without restarting the server.
// Also clears the sheet email cache so campaigns added since last run get a
// fresh deduplication read on the next batch.
app.post('/refresh-routes', async (req, res) => {
  try {
    clearSheetEmailCache();
    const count = await hydrateRouteCache();
    console.log(chalk.green(`🔄 Route cache refreshed — ${count} campaign(s) loaded`));
    res.json({ message: 'Route cache refreshed', campaigns: count });
  } catch (err) {
    console.error(chalk.red('Failed to refresh routes:'), err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/check-sheet-headers', async (req, res) => {
  const { sheetName } = req.query;
  if (!sheetName) {
    return res.status(400).json({ error: 'sheetName query param required' });
  }

  // Find a route that uses this sheetName (any campaign will do).
  const route = [...getAllRoutes().values()].find(r => r.sheetName === sheetName);
  if (!route) {
    return res.status(404).json({ error: `No active route found for sheet "${sheetName}"` });
  }

  try {
    const { sheets } = await getGoogleClients(route.tenantCredentials.googleServiceAccountJson);
    const startColIndex = route.manualColCount + 1;
    const lastCol = columnLetter(route.manualColCount + route.sheetHeaders.length);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: route.googleSheetId,
      range: `${sheetName}!A1:${lastCol}1`,
    });

    const actualHeaders = response.data.values?.[0] || [];
    const comparison = route.sheetHeaders.map((expected, i) => ({
      column: columnLetter(startColIndex + i),
      expected,
      actual: actualHeaders[route.manualColCount + i] || '(missing)',
      match: expected === actualHeaders[route.manualColCount + i],
    }));

    const mismatches = comparison.filter(c => !c.match);
    res.json({
      sheetName,
      totalExpected: route.sheetHeaders.length,
      mismatches: mismatches.length,
      mismatchDetails: mismatches,
      allMatch: mismatches.length === 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =======================
// Scheduler
// =======================
function startScheduler() {
  console.log(chalk.blue(`\n⏰ Scheduler: runs every ${SCHEDULER_INTERVAL_MINUTES} minute(s)`));
  setInterval(processUnprocessedReplies, SCHEDULER_INTERVAL_MINUTES * 60 * 1000);
}

// =======================
// Server Startup
// =======================
async function startServer() {
  try {
    await connectMongoDB();

    const routeCount = await hydrateRouteCache();
    console.log(chalk.green(`✓ Route cache loaded — ${routeCount} campaign(s) across ${getUniqueSheetTargets().size} sheet(s)`));

    if (routeCount === 0) {
      console.warn(chalk.yellow('⚠️  No active campaigns found in DB. Run scripts/migrate.js to seed initial data.'));
    }

    app.listen(PORT, () => {
      // Build tenant → campaignType → { sheetName, campaignCount } tree
      const tree = new Map(); // tenantName → Map<campaignType, { sheetName, count }>
      for (const route of getAllRoutes().values()) {
        if (!tree.has(route.tenantName)) tree.set(route.tenantName, new Map());
        const ct = tree.get(route.tenantName);
        if (!ct.has(route.campaignType)) {
          ct.set(route.campaignType, { sheetName: route.sheetName, count: 0 });
        }
        ct.get(route.campaignType).count++;
      }

      const totalCampaigns = getAllCampaignIds().size;
      const totalSheets    = getUniqueSheetTargets().size;
      const totalTenants   = tree.size;

      console.log(`\n${'='.repeat(60)}`);
      console.log(chalk.green('🚀 Multi-Tenant Lead Enrichment Server'));
      console.log(`📍 Port        : ${PORT}`);
      console.log(`🏢 Tenants     : ${totalTenants}`);
      console.log(`📋 Sheets      : ${totalSheets}`);
      console.log(`🎯 Campaigns   : ${totalCampaigns}`);
      console.log(`${'─'.repeat(60)}`);

      for (const [tenantName, ctMap] of tree) {
        const tenantCampaigns = [...ctMap.values()].reduce((s, v) => s + v.count, 0);
        console.log(chalk.magenta(`  [${tenantName}]`) + chalk.gray(`  (${ctMap.size} type(s), ${tenantCampaigns} campaign(s))`));
        for (const [ctName, { sheetName, count }] of ctMap) {
          console.log(
            chalk.cyan(`    ├─ ${ctName}`) +
            chalk.gray(`  →  sheet: "${sheetName}"  |  ${count} campaign(s)`)
          );
        }
      }

      console.log('='.repeat(60) + '\n');

      startScheduler();

      console.log(chalk.blue('▶️  Running initial processing...'));
      processUnprocessedReplies();
    });
  } catch (error) {
    console.error(chalk.red('Failed to start server:'), error);
    process.exit(1);
  }
}

// =======================
// Graceful Shutdown
// =======================
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, async () => {
    console.log(chalk.yellow(`\n⏹️ Shutting down (${signal})...`));
    await mongoose.connection.close();
    process.exit(0);
  });
});

startServer();
