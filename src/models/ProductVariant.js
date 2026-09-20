const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const productVariantSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },

    sku: { type: String, required: true, trim: true, uppercase: true },
    barcode: { type: String, trim: true },

    // e.g. { size: 'M', color: 'Black' } - free-form so any attribute combination works.
    attributes: { type: Map, of: String, default: {} },

    // --- money fields: stored as integer CENTS ---
    costPrice: { type: Number, required: true, default: 0, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },

    lowStockThreshold: { type: Number, default: 5, min: 0 },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true }
);

productVariantSchema.index({ businessId: 1, sku: 1 }, { unique: true });
productVariantSchema.index({ businessId: 1, barcode: 1 }, { unique: true, sparse: true });
productVariantSchema.index({ businessId: 1, productId: 1 });

moneyFields(productVariantSchema, ['costPrice', 'sellingPrice']);

module.exports = model('ProductVariant', productVariantSchema);
