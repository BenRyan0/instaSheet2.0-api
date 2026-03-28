import { Router } from 'express';
import Tenant from '../models/Tenant.js';

const router = Router();

// GET /api/tenants
router.get('/', async (req, res) => {
  try {
    const tenants = await Tenant.find().select('-credentials').sort({ createdAt: -1 });
    res.json(tenants);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tenants/:id
router.get('/:id', async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id).select('-credentials');
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(tenant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tenants
// Body: { name, slug, googleSheetId, credentials: { instantlyApiKey, openAiApiKey, googleServiceAccountJson }, settings?, limits? }
router.post('/', async (req, res) => {
  try {
    const { name, slug, googleSheetId, credentials, settings, limits } = req.body;

    const missing = ['name', 'slug', 'googleSheetId', 'credentials'].filter(k => !req.body[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const credMissing = ['instantlyApiKey', 'openAiApiKey', 'googleServiceAccountJson']
      .filter(k => !credentials[k]);
    if (credMissing.length) {
      return res.status(400).json({ error: `Missing credentials fields: ${credMissing.join(', ')}` });
    }

    const tenant = await Tenant.create({ name, slug, googleSheetId, credentials, settings, limits });
    const { credentials: _creds, ...safe } = tenant.toObject();
    res.status(201).json(safe);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tenants/:id
// Supports partial updates. Credentials are updated only if provided.
router.put('/:id', async (req, res) => {
  try {
    const allowed = ['name', 'googleSheetId', 'credentials', 'settings', 'limits', 'isActive'];
    const update = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).select('-credentials');

    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(tenant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tenants/:id  — soft delete (sets isActive: false)
router.delete('/:id', async (req, res) => {
  try {
    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    ).select('-credentials');

    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ message: 'Tenant deactivated', tenant });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
