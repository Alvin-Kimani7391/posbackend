const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const PRODUCT_TYPES = ['physical', 'service', 'weighted', 'digital'];
const UNITS = ['piece', 'kg', 'g', 'litre', 'ml', 'metre', 'box', 'packet', 'service'];

const productSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },

    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true, uppercase: true },
    barcode: { type: String, trim: true },
    description: { type: String, trim: true },
    brand: { type: String, trim: true },

    productType: { type: String, enum: PRODUCT_TYPES, default: 'physical' },

    // --- money fields: stored as integer CENTS, see moneySchemaPlugin ---
    costPrice: { type: Number, required: true, default: 0, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    wholesalePrice: { type: Number, min: 0 },

    taxRate: { type: Number, default: 0, min: 0, max: 100 }, // percent
    taxCategory: { type: String, default: 'standard' }, // e.g. standard, zero-rated, exempt

    unit: { type: String, enum: UNITS, default: 'piece' },

    trackInventory: { type: Boolean, default: true },
    trackSerialNumber: { type: Boolean, default: false },
    trackBatch: { type: Boolean, default: false },
    trackExpiry: { type: Boolean, default: false },

    lowStockThreshold: { type: Number, default: 5, min: 0 },

    hasVariants: { type: Boolean, default: false },

    image: { type: String },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

productSchema.index({ businessId: 1, sku: 1 }, { unique: true });
productSchema.index({ businessId: 1, barcode: 1 }, { unique: true, sparse: true });
productSchema.index({ businessId: 1, name: 'text', brand: 'text' });
productSchema.index({ businessId: 1, categoryId: 1 });
productSchema.index({ businessId: 1, status: 1 });

moneyFields(productSchema, ['costPrice', 'sellingPrice', 'wholesalePrice']);

module.exports = model('Product', productSchema);
module.exports.PRODUCT_TYPES = PRODUCT_TYPES;
module.exports.UNITS = UNITS;
