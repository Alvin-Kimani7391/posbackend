const { Schema, model } = require('mongoose');
const ObjectId = Schema.Types.ObjectId;
const biz = { type: ObjectId, ref: 'Business', required: true, index: true };

/* Platform-wide SMS settings (single document, edited by admin). Money = integer cents. */
const SmsSettings = model('SmsSettings', new Schema({
  key: { type: String, default: 'global', unique: true },
  networks: {
    type: [{ key: String, name: String, providerCostCents: Number, serviceFeeCents: Number, enabled: { type: Boolean, default: true }, _id: false }],
    default: () => [
      { key: 'safaricom', name: 'Safaricom', providerCostCents: 695000, serviceFeeCents: 0, enabled: true },
      { key: 'airtel', name: 'Airtel', providerCostCents: 750000, serviceFeeCents: 0, enabled: true },
      { key: 'telkom', name: 'Telkom', providerCostCents: 700000, serviceFeeCents: 0, enabled: true },
    ],
  },
  retailPriceCents: { type: Number, default: 80 },   // what a shop pays per credit (1 credit = 1 SMS segment)
  wholesaleCostCents: { type: Number, default: 50 }, // what you pay TalkSasa per credit (margin reports)
  minTopupCents: { type: Number, default: 10000 },
  stkEnabled: { type: Boolean, default: true },
  manualEnabled: { type: Boolean, default: true },
  paybill: { type: String, default: '' },
  manualInstructions: { type: String, default: '' },
}, { timestamps: true }));

/* Admin-created dynamic offers */
const SmsOffer = model('SmsOffer', new Schema({
  name: { type: String, required: true },
  description: String,
  label: String,
  credits: { type: Number, required: true, min: 1 },
  bonusCredits: { type: Number, default: 0 },
  priceCents: { type: Number, required: true, min: 100 },
  startsAt: Date,
  endsAt: Date,
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true }));

/* Every payment (sender ID fee or SMS top-up), always labelled */
const smsPaymentSchema = new Schema({
  businessId: biz,
  userId: { type: ObjectId, ref: 'User' },
  purpose: { type: String, enum: ['SENDER_ID', 'SMS_TOPUP'], required: true },
  label: String,
  reference: { type: String, required: true, unique: true }, // SID-XXXXXX / SMS-XXXXXX
  amountCents: { type: Number, required: true },
  method: { type: String, enum: ['STK', 'MANUAL'], required: true },
  phone: String,
  mpesaCode: String,                   // unset when a manual payment is rejected so the code can be reused
  mpesaMessage: String,
  claimedCents: Number,
  flags: [String],
  status: { type: String, enum: ['PENDING', 'AWAITING_VERIFICATION', 'PAID', 'FAILED', 'REJECTED'], default: 'PENDING', index: true },
  applicationId: { type: ObjectId, ref: 'SmsSenderIdApplication' },
  offerId: { type: ObjectId, ref: 'SmsOffer' },
  credits: { type: Number, default: 0 },
  providerRef: String,
  failureReason: String,
  verifiedBy: { type: ObjectId, ref: 'User' },
  settledAt: Date,
  note: String,
}, { timestamps: true });
smsPaymentSchema.index({ mpesaCode: 1 }, { unique: true, partialFilterExpression: { mpesaCode: { $type: 'string' } } });
const SmsPayment = model('SmsPayment', smsPaymentSchema);

/* Sender ID application (same fields TalkSasa asks for) */
const SmsSenderIdApplication = model('SmsSenderIdApplication', new Schema({
  businessId: biz,
  reference: { type: String, unique: true },
  senderId: { type: String, required: true },
  purpose: { type: String, enum: ['transactional', 'promotional', 'informational'], required: true },
  samples: [String],
  legalName: String, tradingName: String, kraPin: String,
  signatoryTitle: String, signatoryName: String, phone: String, email: String,
  documents: {
    legal: { file: String, mime: String, name: String },
    signature: { file: String, mime: String, name: String },
    stamp: { file: String, mime: String, name: String },
  },
  accepted: { type: Boolean, default: false },
  networks: [{
    key: String, name: String,
    providerCostCents: Number, serviceFeeCents: Number,
    status: { type: String, enum: ['pending_payment', 'pending', 'submitted', 'approved', 'rejected', 'needs_info'], default: 'pending_payment' },
    note: String, updatedAt: Date, _id: false,
  }],
  totalCents: Number,
  paymentStatus: { type: String, enum: ['unpaid', 'awaiting_verification', 'paid'], default: 'unpaid' },
  paymentId: { type: ObjectId, ref: 'SmsPayment' },
  approvalStatus: { type: String, enum: ['draft', 'pending', 'needs_info', 'partial', 'approved', 'rejected'], default: 'draft', index: true },
  adminNote: String,
}, { timestamps: true }));

/* Approved sender IDs a shop may send from */
const smsSenderIdSchema = new Schema({
  businessId: biz, senderId: String, network: String,
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  applicationId: { type: ObjectId, ref: 'SmsSenderIdApplication' },
}, { timestamps: true });
smsSenderIdSchema.index({ businessId: 1, senderId: 1, network: 1 }, { unique: true });
const SmsSenderId = model('SmsSenderId', smsSenderIdSchema);

const SmsWallet = model('SmsWallet', new Schema({
  businessId: { ...biz, unique: true },
  availableCredits: { type: Number, default: 0, min: 0 },
  totalPurchased: { type: Number, default: 0 },
  totalSent: { type: Number, default: 0 },
}, { timestamps: true }));

const smsLedgerSchema = new Schema({
  businessId: biz,
  type: { type: String, enum: ['TOPUP', 'CAMPAIGN_RESERVE', 'CAMPAIGN_REFUND', 'ADJUSTMENT'], required: true },
  credits: Number,
  amountCents: { type: Number, default: 0 },
  reference: String, note: String,
}, { timestamps: true });
smsLedgerSchema.index({ businessId: 1, type: 1, reference: 1 }, { unique: true, sparse: true });
const SmsLedger = model('SmsLedger', smsLedgerSchema);

const SmsTemplate = model('SmsTemplate', new Schema({
  businessId: biz, name: String, body: String,
}, { timestamps: true }));

const SmsCampaign = model('SmsCampaign', new Schema({
  businessId: biz, createdBy: { type: ObjectId, ref: 'User' },
  name: String, message: String, senderId: String,
  type: { type: String, enum: ['promotional', 'transactional', 'informational'], default: 'promotional' },
  audience: { kind: String, segmentId: String, count: Number },
  scheduledAt: Date,
  status: { type: String, enum: ['scheduled', 'queued', 'sending', 'completed', 'cancelled'], default: 'queued', index: true },
  recipients: Number, credits: Number, refundedCredits: { type: Number, default: 0 },
  completedAt: Date,
}, { timestamps: true }));

const smsMessageSchema = new Schema({
  businessId: biz, campaignId: { type: ObjectId, ref: 'SmsCampaign', index: true },
  customerId: ObjectId, name: String, phone: String, text: String, senderId: String,
  segments: { type: Number, default: 1 },
  status: { type: String, enum: ['held', 'queued', 'sending', 'sent', 'delivered', 'failed', 'cancelled'], default: 'queued', index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: () => new Date() },
  providerMessageId: { type: String, index: true },
  error: String, sentAt: Date, deliveredAt: Date,
}, { timestamps: true });
smsMessageSchema.index({ status: 1, nextAttemptAt: 1 });
const SmsMessage = model('SmsMessage', smsMessageSchema);

module.exports = { SmsSettings, SmsOffer, SmsPayment, SmsSenderIdApplication, SmsSenderId, SmsWallet, SmsLedger, SmsTemplate, SmsCampaign, SmsMessage };