const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

/**
 * A payment THIS BUSINESS made to a supplier, allocated to one or more purchases (supplier invoices).
 * Voiding a payment reverses every allocation. Money is integer cents.
 */
const allocationSchema = new Schema(
  {
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
    purchaseNumber: { type: String },
    amount: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const supplierPaymentSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    paymentNumber: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['CASH', 'MPESA', 'BANK', 'CHEQUE', 'OTHER'], default: 'CASH' },
    reference: { type: String, trim: true },
    paidAt: { type: Date, default: Date.now },
    notes: { type: String, trim: true },
    allocations: { type: [allocationSchema], default: [] },
    status: { type: String, enum: ['COMPLETED', 'VOIDED'], default: 'COMPLETED' },
    voidedAt: { type: Date },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    voidReason: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supplierPaymentSchema.index({ businessId: 1, paymentNumber: 1 }, { unique: true });
supplierPaymentSchema.index({ businessId: 1, supplierId: 1, paidAt: -1 });

moneyFields(supplierPaymentSchema, ['amount'], { allocations: ['amount'] });

module.exports = model('SupplierPayment', supplierPaymentSchema);
