const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { CONTRACTOR_MODES } = require('../constants/hardware');
/** A customer's own price for a product or a whole category. FIXED = cents per base unit; PERCENT_OFF / COST_PLUS = percent. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product' },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
  mode: { type: String, enum: CONTRACTOR_MODES, required: true },
  value: { type: Number, required: true, min: 0 },
  minQty: { type: Number, default: 0, min: 0 },   // base units
  validFrom: Date, validTo: Date,
  active: { type: Boolean, default: true },
  notes: { type: String, trim: true, maxlength: 200 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
schema.index({ businessId: 1, customerId: 1, active: 1 });
schema.pre('validate', function (next) { if (!this.productId && !this.categoryId) return next(new Error('Choose a product or a category')); if (this.mode === 'PERCENT_OFF' && this.value > 100) return next(new Error('Percent cannot be over 100')); next(); });
module.exports = model('ContractorPrice', schema);
