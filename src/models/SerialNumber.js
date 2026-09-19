const { Schema, model } = require('mongoose');

const serialNumberSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },

    serialNumber: { type: String, required: true, trim: true },
    status: { type: String, enum: ['in_stock', 'sold', 'damaged', 'returned'], default: 'in_stock' },

    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase' },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale' },

    warrantyStart: { type: Date },
    warrantyEnd: { type: Date },
  },
  { timestamps: true }
);

// Unique per business (not per branch) - a serial number can only exist
// once anywhere in the business, matching how real serial numbers work.
serialNumberSchema.index({ businessId: 1, serialNumber: 1 }, { unique: true });
serialNumberSchema.index({ businessId: 1, branchId: 1, productId: 1, status: 1 });

module.exports = model('SerialNumber', serialNumberSchema);
