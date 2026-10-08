const { Schema, model } = require('mongoose');

/** Append-only timeline (per business, or platform-level when businessId is null): invoices, payments, emails, locks, admin actions. */
const billingEventSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null, index: true },
    subscriptionId: { type: Schema.Types.ObjectId },
    invoiceId: { type: Schema.Types.ObjectId },
    paymentId: { type: Schema.Types.ObjectId },
    type: { type: String, required: true }, // INVOICE_ISSUED, PAYMENT_SUCCESS, LOCKED, EMAIL_SENT, ADMIN_*, ...
    message: { type: String, required: true },
    actorId: { type: Schema.Types.ObjectId },
    actorName: { type: String },
    data: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
billingEventSchema.index({ businessId: 1, createdAt: -1 });

module.exports = model('BillingEvent', billingEventSchema);