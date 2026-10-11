const { Schema, model } = require('mongoose');

/**
 * One document per M-PESA till payment a cashier recorded while the till was OFFLINE:
 * the customer paid the shop's Till, the cashier read the M-PESA SMS on the customer's phone and
 * typed the 10-character code + the customer's phone number.
 *
 *   VERIFIED_AUTO  - at sync the code was found in the till inbox (MpesaInboundPayment), unclaimed, exact amount
 *   PENDING_REVIEW - could not be proven automatically; a manager/owner must approve or reject it
 *   APPROVED       - a manager/owner confirmed it (who/when/note recorded)
 *   REJECTED       - a manager/owner refused it; the sale shows the amount as unpaid again
 *
 * `activeCode` is set ONLY for VERIFIED_AUTO/APPROVED claims. The partial unique index on it
 * guarantees one M-PESA code can never be accepted for two sales.
 * Money here is integer cents with an explicit "Cents" suffix (not run through moneyFields).
 */
const claimSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
    mpesaTransactionId: { type: Schema.Types.ObjectId, ref: 'MpesaTransaction' },
    matchedInboundId: { type: Schema.Types.ObjectId, ref: 'MpesaInboundPayment' },

    deviceId: { type: String },
    deviceCode: { type: String },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    mpesaCode: { type: String, required: true, uppercase: true, trim: true },
    payerPhone: { type: String, trim: true },
    payerPhoneNormalized: { type: String, trim: true },
    payerName: { type: String, trim: true },
    amountCents: { type: Number, required: true },
    soldAt: { type: Date, required: true },

    status: { type: String, enum: ['VERIFIED_AUTO', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'], required: true },
    reason: {
      type: String,
      enum: ['NOT_REPORTED_YET', 'AMOUNT_MISMATCH', 'ALREADY_CONSUMED', 'DUPLICATE_CODE', 'APPROVAL_REQUIRED', 'OVER_LIMIT', 'NOT_ALLOWED', 'CLAIM_RACE'],
    },
    autoResolvable: { type: Boolean, default: false }, // true only when the payment may simply not have reached us yet
    activeCode: { type: String },

    flags: [{ _id: false, code: String, severity: { type: String, enum: ['INFO', 'WARN', 'HIGH'] }, detail: String }],

    verifiedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String },
    escalatedAt: { type: Date },
  },
  { timestamps: true }
);

claimSchema.index({ businessId: 1, mpesaCode: 1 });
claimSchema.index({ businessId: 1, status: 1, createdAt: -1 });
claimSchema.index({ status: 1, autoResolvable: 1, createdAt: 1 }); // sweep
claimSchema.index(
  { businessId: 1, activeCode: 1 },
  { unique: true, partialFilterExpression: { activeCode: { $type: 'string' } } }
);

module.exports = model('OfflineMpesaClaim', claimSchema);