import mongoose from 'mongoose';

const AutoReplyRecordSchema = new mongoose.Schema({
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

  // The 1-based row number in the sheet — used to update the existing row
  // when the lead replies to the auto-reply.
  sheetRowNumber: {
    type: Number,
    required: true,
  },

  // Whether the lead's follow-up reply has been handled.
  isResolved: {
    type: Boolean,
    default: false,
    index: true,
  },
}, {
  timestamps: true,
});

AutoReplyRecordSchema.index({ lead_email: 1, campaign_id: 1, isResolved: 1 });

export default mongoose.model('AutoReplyRecord', AutoReplyRecordSchema);
