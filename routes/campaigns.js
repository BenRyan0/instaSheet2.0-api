import { Router } from 'express';
import Campaign from '../models/Campaign.js';
import CampaignType from '../models/CampaignType.js';
import { hydrateRouteCache } from '../services/routingService.js';

const router = Router();

// GET /api/campaigns?tenant=<id>&campaignType=<id>
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.tenant) filter.tenant = req.query.tenant;
    if (req.query.campaignType) filter.campaignType = req.query.campaignType;

    const campaigns = await Campaign.find(filter)
      .populate('tenant', 'name slug')
      .populate('campaignType', 'name sheetName')
      .sort({ createdAt: -1 });

    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id)
      .populate('tenant', 'name slug')
      .populate('campaignType', 'name sheetName');
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns
// Single:  { campaignId, campaignType, tenant }
// Bulk:    { campaignIds: [...], campaignType, tenant }
router.post('/', async (req, res) => {
  try {
    const { campaignId, campaignIds, campaignType, tenant } = req.body;

    if (!campaignType || !tenant) {
      return res.status(400).json({ error: 'Missing required fields: campaignType, tenant' });
    }

    const ids = campaignIds?.length ? campaignIds : campaignId ? [campaignId] : [];
    if (!ids.length) {
      return res.status(400).json({ error: 'Provide campaignId or campaignIds[]' });
    }

    // Verify campaignType belongs to the given tenant
    const ct = await CampaignType.findOne({ _id: campaignType, tenant });
    if (!ct) {
      return res.status(404).json({ error: 'CampaignType not found for this tenant' });
    }

    const ops = ids.map(cid => ({
      updateOne: {
        filter: { campaignId: cid },
        update: { $set: { campaignId: cid, campaignType, tenant, isActive: true } },
        upsert: true,
      },
    }));

    const result = await Campaign.bulkWrite(ops);
    await hydrateRouteCache();

    res.status(201).json({
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
      total: ids.length,
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'One or more campaignIds already exist under a different CampaignType' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res) => {
  try {
    const allowed = ['campaignType', 'tenant', 'isActive'];
    const update = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).populate('campaignType', 'name sheetName');

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await hydrateRouteCache();
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id  — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await hydrateRouteCache();
    res.json({ message: 'Campaign deactivated', campaignId: campaign.campaignId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
