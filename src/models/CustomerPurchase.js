const { Schema, model } = require('mongoose');

/**
 * One row per Sale that can be tied to a customer (by sale.customerId, or by the phone of the
 * successful M-PESA payment that paid for it). It is a read-model owned by the CRM: the Sale
 * itself is never modified. Everything is integer cents.
 *
 * Unique (businessId, saleId) makes every sync idempotent - re-running it just refreshes the row.
 */
const customerPurchaseSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    saleNumber: { type: String },

    amountCents: { type: Number, default: 0 },
    refundedCents: { type: Number, default: 0 },
    itemCount: { type: Number, default: 0 },
    categories: { type: [{ _id: false, name: String, amountCents: Number }], default: [] },
    paymentMethods: { type: [String], default: [] },
    mpesaReceipt: { type: String },
    linkedBy: { type: String, enum: ['sale', 'mpesa'], default: 'sale' }, // how the customer was identified

    purchasedAt: { type: Date, required: true },
    voided: { type: Boolean, default: false },
  },
  { timestamps: true }
);

customerPurchaseSchema.index({ businessId: 1, saleId: 1 }, { unique: true });
customerPurchaseSchema.index({ businessId: 1, customerId: 1, purchasedAt: -1 });
customerPurchaseSchema.index({ businessId: 1, purchasedAt: -1 });

module.exports = model('CustomerPurchase', customerPurchaseSchema);