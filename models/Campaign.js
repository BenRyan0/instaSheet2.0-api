import mongoose from 'mongoose';

const CampaignSchema = new mongoose.Schema({
  // The UUID from Instantly.ai — must be unique across all tenants.
  campaignId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  name: {
    type: String,
    required: true,
    trim: true,
  },

  campaignType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CampaignType',
    required: true,
  },

  // Denormalized for fast single-query lookups without a double-populate.
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
    index: true,
  },

  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
}, {
  timestamps: true,
});

export default mongoose.model('Campaign', CampaignSchema);
