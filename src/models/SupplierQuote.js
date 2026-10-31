const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
/** A price a supplier quoted for a product. unitPrice is per QUOTED unit (cents); pricePerBase is worked out for comparison. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  unitName: { type: String, trim: true, maxlength: 30 }, unitFactor: { type: Number, default: 1, min: 0.001 },
  unitPrice: { type: Number, required: true, min: 0 }, pricePerBase: { type: Number, required: true, min: 0 },
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  minQty: { type: Number, default: 0, min: 0 },
  leadTimeDays: { type: Number, min: 0, max: 365 },
  validUntil: Date, reference: { type: String, trim: true, maxlength: 60 }, notes: { type: String, trim: true, maxlength: 200 },
  status: { type: String, enum: ['OPEN', 'ACCEPTED', 'REJECTED', 'EXPIRED'], default: 'OPEN' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
schema.index({ businessId: 1, productId: 1, status: 1 });
moneyFields(schema, ['unitPrice', 'pricePerBase']);
module.exports = model('SupplierQuote', schema);
