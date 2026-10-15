const { Schema, model } = require('mongoose');

/**
 * A move of stock BETWEEN the warehouse and the retail floor of the SAME branch (either direction).
 * Instant and atomic (one transaction): both ledger rows, batch and serial moves are written together, and this
 * document records exactly what moved, who moved it and why. (Branch-to-branch moves stay in StockTransfer.)
 */
const itemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
    nameSnapshot: { type: String },
    quantity: { type: Number, required: true, min: 0 },
    unitCostCents: { type: Number, default: 0 },
    batchAllocations: [{
      _id: false,
      batchId: { type: Schema.Types.ObjectId, ref: 'Batch' },
      batchNumber: String,
      expiryDate: Date,
      quantity: Number,
    }],
    serialNumbers: [String],
  },
  { _id: false }
);

const locationTransferSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    transferNumber: { type: String, required: true },
    fromLocation: { type: String, enum: ['WAREHOUSE', 'RETAIL'], required: true },
    toLocation: { type: String, enum: ['WAREHOUSE', 'RETAIL'], required: true },
    items: { type: [itemSchema], required: true, validate: (v) => v.length > 0 },
    notes: { type: String },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

locationTransferSchema.index({ businessId: 1, transferNumber: 1 }, { unique: true });
locationTransferSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });

module.exports = model('LocationTransfer', locationTransferSchema);
