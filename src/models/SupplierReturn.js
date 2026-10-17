const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

/**
 * Stock sent back to a supplier, traced to the exact batch (expired, damaged, recalled, wrong item). The stock leaves when the
 * return is made; the supplier's credit note is recorded afterwards and applied to what we owe them.
 */
const supplierReturnSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    number: { type: String, required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase' },
    recallId: { type: Schema.Types.ObjectId, ref: 'RecallRecord' },
    lines: [{
      _id: false,
      batchId: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
      productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
      nameSnapshot: String, batchNumber: String, expiryDate: Date,
      quantity: { type: Number, required: true, min: 0.001 },
      unitCost: { type: Number, default: 0 },
      reason: { type: String, enum: ['EXPIRED', 'DAMAGED', 'RECALL', 'WRONG_ITEM', 'OVERSUPPLY', 'OTHER'], required: true },
    }],
    totalValue: { type: Number, default: 0 },          // at cost, integer cents
    status: { type: String, enum: ['RETURNED', 'CREDITED'], default: 'RETURNED' },
    creditNote: { type: new Schema({ number: String, amount: Number, appliedAmount: Number, paymentId: Schema.Types.ObjectId, at: Date, by: Schema.Types.ObjectId }, { _id: false }) },
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supplierReturnSchema.index({ businessId: 1, number: 1 }, { unique: true });
supplierReturnSchema.index({ businessId: 1, supplierId: 1, createdAt: -1 });
supplierReturnSchema.index({ businessId: 1, 'lines.batchId': 1 });

moneyFields(supplierReturnSchema, ['totalValue'], { lines: ['unitCost'] });

module.exports = model('SupplierReturn', supplierReturnSchema);