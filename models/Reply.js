import mongoose from 'mongoose';

const ReplySchema = new mongoose.Schema(
  {
    campaign_id: String,

    email: String,
    email_account: String,
    to_email: String,

    company_name: String,

    lead_email: String,

    reply_text: String,
    reply_text_snippet: String,

    reply_subject: String,
    campaign_name: String,

    email_id: String,
    display_name: String,

    isProcessed: {
      type: Boolean,
      default: false,
      index: true,
    },

    replyType: {
      type: String,
      enum: ['fresh', 'auto_reply_response', 'data_fill_response'],
      default: 'fresh',
      index: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model('Reply', ReplySchema);
