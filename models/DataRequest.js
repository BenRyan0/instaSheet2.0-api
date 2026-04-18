import mongoose from 'mongoose';

const DataRequestSchema = new mongoose.Schema({
  lead_email: {
    type: String,
    required: true,
    index: true,
  },

  campaign_id: {
    type: String,
    required: true,
    index: true,
  },

  googleSheetId: {
    type: String,
    required: true,
  },

  sheetName: {
    type: String,
    required: true,
  },

  // The exact 1-based row number written to the sheet, used for targeted cell updates.
  sheetRowNumber: {
    type: Number,
    required: true,
  },

  // Sheet column names that were missing and were requested from the lead.
  requestedFields: {
    type: [String],
    default: [],
  },

  // The sending email account used (to thread the reply correctly).
  emailAccount: {
    type: String,
    default: '',
  },

  // The email_id of the original lead reply — used as reply_to_uuid when sending the follow-up.
  replyEmailId: {
    type: String,
    default: '',
  },

  isResolved: {
    type: Boolean,
    default: false,
    index: true,
  },
}, {
  timestamps: true,
});

// Compound index for the pre-dedup lookup in processReply.
DataRequestSchema.index({ lead_email: 1, campaign_id: 1, isResolved: 1 });

// Unique index: prevents duplicate DataRequest documents for the exact same
// reply email (replyEmailId), campaign, and lead — hard DB-level guard against
// race conditions that bypass the application-level check.
DataRequestSchema.index({ replyEmailId: 1, campaign_id: 1, lead_email: 1 }, { unique: true, sparse: true });

export default mongoose.model('DataRequest', DataRequestSchema);
