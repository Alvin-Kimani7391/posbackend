const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

/**
 * UnitConversion - one "break down" of stock into sellable sizes (a 25 kg bag -> 20 x 1 kg + 10 x 500 g).
 * Stock is ONE pool counted in the product's base unit, so breaking itself never changes the quantity on hand;
 * only wastage does. This record keeps the audit trail: what was broken, into what, the wastage, the packaging
 * cost that was added and the cost per base unit before / after (so profit stays exact).
 */
const outputSchema = new Schema({
  unitId: { type: Schema.Types.ObjectId },
  unitName: { type: String, required: true },
  unitFactor: { type: Number, required: true },
  count: { type: Number, required: true },
  baseQuantity: { type: Number, required: true },
  costEach: { type: Number, default: 0 },     // cents, after packaging cost / absorbed wastage
  priceEach: { type: Number, default: 0 },    // cents, retail price of one piece at the time
}, { _id: false });

const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
  location: { type: String, enum: ['RETAIL', 'WAREHOUSE'], default: 'RETAIL' },

  sourceUnitName: { type: String },
  sourceQuantity: { type: Number },            // as entered (e.g. 1 bag)
  sourceBase: { type: Number, required: true }, // in base units (25)
  baseUnitName: { type: String },

  outputs: { type: [outputSchema], default: [] },
  leftoverBase: { type: Number, default: 0 },   // stays loose in stock
  wastageBase: { type: Number, default: 0 },
  absorbWastage: { type: Boolean, default: false },
  wastageLoss: { type: Number, default: 0 },    // cents written off (0 when absorbed into cost)
  extraCost: { type: Number, default: 0 },      // cents: bags, labels, labour added to the cost

  costPerBaseBefore: { type: Number, default: 0 }, // cents
  costPerBaseAfter: { type: Number, default: 0 },  // cents

  note: { type: String, trim: true, maxlength: 300 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index({ businessId: 1, productId: 1, createdAt: -1 });
schema.index({ businessId: 1, branchId: 1, createdAt: -1 });

moneyFields(schema, ['wastageLoss', 'extraCost', 'costPerBaseBefore', 'costPerBaseAfter'], { outputs: ['costEach', 'priceEach'] });

module.exports = model('UnitConversion', schema);
