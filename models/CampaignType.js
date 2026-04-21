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

  // When enabled, the system sends an automated reply via Instantly after a
  // lead is confirmed interested and written to the sheet.
  // The subject/body templates are passed through OpenAI to fill in
  // personalization placeholders (e.g. company name, first name).
  autoReply: {
    enabled: {
      type: Boolean,
      default: false,
    },
    subject: {
      type: String,
      default: '',
    },
    bodyHtml: {
      type: String,
      default: '',
    },
    bodyText: {
      type: String,
      default: '',
    },
  },

  // Scheduled follow-up sent to leads who never replied to the auto-reply.
  // Uses a separate email template from autoReply.
  autoReplyFollowUp: {
    enabled: {
      type: Boolean,
      default: false,
    },
    // Hours to wait after the auto-reply (or last follow-up) before sending.
    intervalHours: {
      type: Number,
      default: 24,
    },
    // Maximum number of follow-up emails to send per lead.
    maxFollowUps: {
      type: Number,
      default: 1,
    },
    bodyText: {
      type: String,
      default: '',
    },
    link: {
      type: String,
      default: '',
    },
  },

  // When enabled, the system checks if any of requiredFields are blank after
  // encoding a lead. If so, it sends a follow-up via Instantly asking for
  // the missing data. When the lead replies, the existing sheet row is updated
  // in place instead of creating a new row.
  dataRequestFollowUp: {
    enabled: {
      type: Boolean,
      default: false,
    },
    // Sheet column names that must be non-empty; any blank ones trigger a follow-up.
    requiredFields: {
      type: [String],
      default: [],
    },
    subject: {
      type: String,
      default: '',
    },
    bodyText: {
      type: String,
      default: '',
    },
    // Column name that is the "make-or-break" field for resolving the DataRequest.
    // If set and the lead provides this field in their reply, the DataRequest resolves
    // immediately even if other requiredFields are still missing, and a CRM payload
    // is queued for dispatch once credentials are configured.
    // Leave blank to use the original behaviour (always resolve after any reply).
    priorityField: {
      type: String,
      default: '',
    },
  },

  // Reply classification playbook — JSON object defining categories and sub-variants.
  // When set, incoming follow-up replies are classified by OpenAI using this playbook
  // before the result is included in the outbound callback POST.
  // Set to null to disable classification for this campaign type.
  replyPlaybook: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },

  // Outbound callback — POST processed follow-up reply data to an external system.
  // Toggle enabled per campaign type without changing the URL.
  callback: {
    enabled: {
      type: Boolean,
      default: false,
    },
    url: {
      type: String,
      default: '',
    },
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
