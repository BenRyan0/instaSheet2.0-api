import Campaign from '../models/Campaign.js';
import '../models/CampaignType.js';
import '../models/Tenant.js';

// In-memory route cache.
// Key: campaignId (Instantly UUID)
// Value: fully resolved route object (no DB round-trip needed per reply)
const routeCache = new Map();

/**
 * Load all active campaigns from the DB and build the route cache.
 * Call once at startup and whenever routes change (/refresh-routes).
 *
 * Each cache entry contains everything processReply needs:
 *   sheetName, campaignType, emailTemplate, sheetHeaders,
 *   manualColCount, addressMapping, googleSheetId,
 *   tenantCredentials, tenantSettings
 */
export async function hydrateRouteCache() {
  const campaigns = await Campaign.find({ isActive: true }).populate({
    path: 'campaignType',
    populate: { path: 'tenant' },
  });

  routeCache.clear();

  for (const campaign of campaigns) {
    const ct = campaign.campaignType;
    const tenant = ct?.tenant;

    if (!ct || !tenant || !tenant.isActive || !ct.isActive) continue;

    routeCache.set(campaign.campaignId, {
      tenantName:             tenant.name,
      sheetName:              ct.sheetName,
      campaignType:           ct.name,
      emailTemplate:          ct.emailTemplate,
      sheetHeaders:           ct.sheetHeaders,
      manualColCount:         ct.manualColCount,
      addressMapping:         ct.addressMapping,
      autoReply:              ct.autoReply,
      autoReplyFollowUp:      ct.autoReplyFollowUp,
      dataRequestFollowUp:    ct.dataRequestFollowUp,
      googleSheetId:          tenant.googleSheetId,
      tenantCredentials:      tenant.credentials,
      tenantSettings:         tenant.settings,
    });
  }

  return routeCache.size;
}

/** Look up a fully resolved route for one Instantly campaign ID. */
export function getRouteForCampaign(campaignId) {
  return routeCache.get(campaignId) || null;
}

/** Set of all tracked Instantly campaign IDs (for the MongoDB $in query). */
export function getAllCampaignIds() {
  return new Set(routeCache.keys());
}

/**
 * All unique sheet targets across all tenants.
 * Returns a Map keyed by `${googleSheetId}:${sheetName}` → route object.
 * Used by processUnprocessedReplies to set up sheets before processing.
 */
export function getUniqueSheetTargets() {
  const sheetMap = new Map();
  for (const route of routeCache.values()) {
    const key = `${route.googleSheetId}:${route.sheetName}`;
    if (!sheetMap.has(key)) {
      sheetMap.set(key, route);
    }
  }
  return sheetMap;
}

/** Expose the raw cache for diagnostics (e.g. /routing endpoint). */
export function getAllRoutes() {
  return routeCache;
}

export function invalidateCache() {
  routeCache.clear();
}
