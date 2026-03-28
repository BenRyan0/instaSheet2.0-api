import mongoose from 'mongoose';

const DEFAULT_SHEET_HEADERS = [
  'Date',
  'Hot Lead',
  'For Scheduling',
  'Sales Person',
  'Sales Person Email',
  'Lead First Name',
  'Lead Last Name',
  'Lead Email',
  'Phone From Reply',
  'Phone From Instantly',
  'Phone 2',
  'Phone 3',
  'Reply Text',
  'Email Signature',
  'Address',
  'City',
  'State',
  'Zip',
  'LinkedIn',
  'Details',
  'Campaign Name',
  '@dropdown',
];

const CampaignTypeSchema = new mongoose.Schema({
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
    index: true,
  },

  name: {
    type: String,
    required: true,
    trim: true,
  },

  sheetName: {
    type: String,
    required: true,
    trim: true,
  },

  emailTemplate: {
    type: String,
    required: true,
  },

  sheetHeaders: {
    type: [String],
    default: DEFAULT_SHEET_HEADERS,
  },

  // Number of columns reserved for manual data before automation columns start.
  // e.g. 6 means automation starts at column G.
  manualColCount: {
    type: Number,
    default: 6,
  },

  // How to map address fields from Instantly to the sheet.
  // 'direct' — use structured fields (address, city, state, zip)
  // 'parse'  — AI parses a raw combined address string
  // 'skip'   — leave address blank
  addressMapping: {
    type: String,
    enum: ['direct', 'parse', 'skip'],
    default: 'direct',
  },

  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
}, {
  timestamps: true,
});

// A tenant cannot have two campaign types pointing to the same sheet tab.
CampaignTypeSchema.index({ tenant: 1, sheetName: 1 }, { unique: true });

export default mongoose.model('CampaignType', CampaignTypeSchema);
