const { Schema, model } = require('mongoose');
const { PAYMENT_METHODS, PAYMENT_STATUSES } = require('../constants/billing');

/**
 * One payment attempt toward a business's platform subscription.
 * STK          : PENDING -> SUCCESS | FAILED (money confirmed only via a live PayHero status check)
 * MPESA_MANUAL : SUBMITTED (owner pasted SMS) -> SUCCESS | REJECTED (super admin decides)
 * CASH/BANK/OTHER : recorded by admin, created directly as SUCCESS
 */
const subscriptionPaymentSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true, index: true },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    source: { type: String, enum: ['OWNER', 'ADMIN'], default: 'OWNER' },

    method: { type: String, enum: PAYMENT_METHODS, required: true },
    status: { type: String, enum: PAYMENT_STATUSES, required: true, index: true },

    amount: { type: Number, required: true, min: 0 }, // cents; for MANUAL becomes the admin-verified amount on approval
    claimedAmount: { type: Number }, // what the owner said / what the SMS said

    reference: { type: String, required: true, unique: true }, // our reference: BLP- (STK), BLM- (manual), BLA- (admin)
    phone: { type: String },
    providerReference: { type: String },
    checkoutRequestId: { type: String },
    callbackToken: { type: String, select: false },

    mpesaReceiptNumber: { type: String },
    receiptKey: { type: String, unique: true, sparse: true }, // set only while a code is "in use" => blocks double submission
    mpesaMessage: { type: String, maxlength: 1000 },
    parsed: { type: Schema.Types.Mixed }, // { code, amountCents, recipient }
    flags: [{ type: String }], // AMOUNT_NOT_IN_MESSAGE | RECIPIENT_NOT_FOUND | SIMILAR_RECENT_STK | ...

    failureType: { type: String, default: '' },
    resultDesc: { type: String },
    rawInitiateResponse: { type: Schema.Types.Mixed, select: false },
    rawCallback: { type: Schema.Types.Mixed, select: false },

    review: { by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String, at: Date, note: String },

    allocations: [{ _id: false, invoiceId: Schema.Types.ObjectId, invoiceNumber: String, amount: Number }],
    creditAddedCents: { type: Number, default: 0 },
    allocatedAt: { type: Date, default: null },

    settledAt: { type: Date },
    lastCheckedAt: { type: Date },
  },
  { timestamps: true }
);

subscriptionPaymentSchema.index({ status: 1, method: 1, createdAt: 1 });
subscriptionPaymentSchema.index({ businessId: 1, createdAt: -1 });

module.exports = model('SubscriptionPayment', subscriptionPaymentSchema);