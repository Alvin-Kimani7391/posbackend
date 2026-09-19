const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const batchSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },

    batchNumber: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 }, // remaining quantity in this batch
    costPrice: { type: Number, default: 0 }, // integer cents, cost at time of receiving this batch

    manufacturingDate: { type: Date },
    expiryDate: { type: Date },

    status: { type: String, enum: ['active', 'expired', 'depleted'], default: 'active' },
  },
  { timestamps: true }
);

batchSchema.index({ businessId: 1, branchId: 1, productId: 1, batchNumber: 1 }, { unique: true });
batchSchema.index({ businessId: 1, expiryDate: 1 });

moneyFields(batchSchema, ['costPrice']);

module.exports = model('Batch', batchSchema);
