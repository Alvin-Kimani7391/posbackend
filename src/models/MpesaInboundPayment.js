const { Schema, model } = require('mongoose');

/**
 * One document per M-PESA payment that PayHero told us arrived on the business's Till
 * (the customer paid via Lipa na M-PESA -> Buy Goods and Services, no STK prompt).
 *
 * This is an INBOX, not a sale: nothing here is money the POS has accepted yet. A row
 * starts UNCLAIMED and only becomes CLAIMED when mpesa.service matches it to exactly one
 * pending MANUAL MpesaTransaction (same amount, right time window, no ambiguity) or a
 * cashier confirms it with the customer's M-PESA code. The status flip UNCLAIMED -> CLAIMED
 * is a single atomic conditional update, so one payment can never pay for two sales.
 *
 * The unique (businessId, mpesaReceiptNumber) index makes PayHero webhook retries harmless.
 */
const mpesaInboundPaymentSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    mpesaReceiptNumber: { type: String, required: true, uppercase: true, trim: true }, // e.g. "TJK1A2B3C4"
    amount: { type: Number, required: true }, // integer cents
    payerPhone: { type: String },
    payerName: { type: String },
    tillNumber: { type: String },
    paidAt: { type: Date }, // time reported by the provider (informational only - matching uses createdAt, our own clock)

    status: { type: String, enum: ['UNCLAIMED', 'CLAIMED'], default: 'UNCLAIMED' },
    claimedByReference: { type: String }, // MpesaTransaction.reference that used this payment
    claimedAt: { type: Date },
    escalatedAt: { type: Date }, // set once management was told this payment never matched a sale

    rawPayload: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

mpesaInboundPaymentSchema.index({ businessId: 1, mpesaReceiptNumber: 1 }, { unique: true });
mpesaInboundPaymentSchema.index({ businessId: 1, status: 1, amount: 1, createdAt: 1 });
mpesaInboundPaymentSchema.index({ status: 1, escalatedAt: 1, createdAt: 1 }); // reconciliation sweep

module.exports = model('MpesaInboundPayment', mpesaInboundPaymentSchema);