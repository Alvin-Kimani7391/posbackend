const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const TYPES = ['PERCENT', 'AMOUNT_OFF', 'FIXED_PRICE', 'MULTI_BUY'];
// PERCENT: value = % off the unit price. AMOUNT_OFF: value = cents off EACH unit. FIXED_PRICE: value = the unit price (cents) while the offer runs.
// MULTI_BUY: buy `buyQty`, pay for `payQty` (3 for the price of 2). Applies to complete groups only.
const promotionSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 300 },
  type: { type: String, enum: TYPES, required: true },
  value: { type: Number, min: 0 },
  buyQty: { type: Number, min: 2 },
  payQty: { type: Number, min: 1 },
  scope: { type: String, enum: ['ALL', 'PRODUCTS', 'CATEGORIES'], default: 'PRODUCTS' },
  productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  categoryIds: [{ type: Schema.Types.ObjectId, ref: 'Category' }],
  branchIds: [{ type: Schema.Types.ObjectId, ref: 'Branch' }], // empty = every branch
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  daysOfWeek: { type: [Number], default: [] },   // 0 = Sunday; empty = every day (business time zone)
  minQty: { type: Number, default: 0, min: 0 },  // offer starts at this quantity of the product
  status: { type: String, enum: ['ACTIVE', 'PAUSED'], default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

promotionSchema.index({ businessId: 1, status: 1, startsAt: 1, endsAt: 1 });
promotionSchema.pre('validate', function check(next) {
  if (this.endsAt <= this.startsAt) return next(new Error('End must be after start'));
  if (this.type === 'MULTI_BUY') { if (!(this.buyQty > this.payQty)) return next(new Error('Buy quantity must be more than pay quantity')); }
  else if (!(this.value >= 0)) return next(new Error('Value is required'));
  if (this.type === 'PERCENT' && this.value > 100) return next(new Error('Percent cannot exceed 100'));
  if (this.scope === 'PRODUCTS' && !this.productIds.length) return next(new Error('Pick at least one product'));
  if (this.scope === 'CATEGORIES' && !this.categoryIds.length) return next(new Error('Pick at least one category'));
  return next();
});
// value is cents for AMOUNT_OFF / FIXED_PRICE only, so it is converted in the service output, not by the plugin.
promotionSchema.set('toJSON', { virtuals: true });
module.exports = model('Promotion', promotionSchema);
module.exports.TYPES = TYPES;
void moneyFields;
