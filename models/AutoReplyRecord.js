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

  // Sending account used for the auto-reply — needed to thread follow-ups.
  emailAccount: {
    type: String,
    default: '',
  },

  // email_id of the original lead reply — used as reply_to_uuid for follow-ups.
  replyEmailId: {
    type: String,
    default: '',
  },

  // Subject line of the original reply thread.
  replySubject: {
    type: String,
    default: '',
  },

  // How many scheduled follow-ups have been sent so far.
  followUpCount: {
    type: Number,
    default: 0,
  },

  // When the most recent scheduled follow-up was sent.
  lastFollowUpAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

AutoReplyRecordSchema.index({ lead_email: 1, campaign_id: 1, isResolved: 1 });

export default mongoose.model('AutoReplyRecord', AutoReplyRecordSchema);
