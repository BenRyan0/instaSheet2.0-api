import { Router } from 'express';
import CampaignType from '../models/CampaignType.js';
import Campaign from '../models/Campaign.js';
import { hydrateRouteCache } from '../services/routingService.js';

const router = Router();

// GET /api/campaign-types?tenant=<id>
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.tenant) filter.tenant = req.query.tenant;

    const types = await CampaignType.find(filter)
      .populate('tenant', 'name slug googleSheetId')
      .sort({ createdAt: -1 });

    res.json(types);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaign-types/:id
router.get('/:id', async (req, res) => {
  try {
    const ct = await CampaignType.findById(req.params.id)
      .populate('tenant', 'name slug googleSheetId');
    if (!ct) return res.status(404).json({ error: 'CampaignType not found' });
    res.json(ct);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaign-types
// Body: { tenant, name, sheetName, emailTemplate, manualColCount?, addressMapping?, sheetHeaders?, autoReply? }
router.post('/', async (req, res) => {
  try {
    const { tenant, name, sheetName, emailTemplate, manualColCount, addressMapping, sheetHeaders, autoReply } = req.body;

    const missing = ['tenant', 'name', 'sheetName', 'emailTemplate'].filter(k => !req.body[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const ct = await CampaignType.create({
      tenant, name, sheetName, emailTemplate,
      ...(manualColCount !== undefined && { manualColCount }),
      ...(addressMapping && { addressMapping }),
      ...(sheetHeaders?.length && { sheetHeaders }),
      ...(autoReply !== undefined && { autoReply }),
    });

    await hydrateRouteCache();
    res.status(201).json(ct);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A CampaignType with that sheetName already exists for this tenant' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/campaign-types/:id
router.put('/:id', async (req, res) => {
  try {
    const allowed = ['name', 'sheetName', 'emailTemplate', 'sheetHeaders', 'manualColCount', 'addressMapping', 'isActive', 'autoReply'];
    const update = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const ct = await CampaignType.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).populate('tenant', 'name slug');

    if (!ct) return res.status(404).json({ error: 'CampaignType not found' });

    await hydrateRouteCache();
    res.json(ct);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaign-types/:id  — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const ct = await CampaignType.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );
    if (!ct) return res.status(404).json({ error: 'CampaignType not found' });

    // Also deactivate all campaigns under this type
    await Campaign.updateMany({ campaignType: req.params.id }, { $set: { isActive: false } });

    await hydrateRouteCache();
    res.json({ message: 'CampaignType deactivated', id: ct._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
