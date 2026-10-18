const { Schema, model } = require('mongoose');
const { ALLERGENS } = require('../constants/restaurant');
const moneyPaths = require('../utils/moneyDeepPlugin');
const option = new Schema({
  name: { type: String, required: true, trim: true },
  priceDelta: { type: Number, default: 0 },          // integer cents, may be 0 ("no onions")
  costDelta: { type: Number, default: 0 },           // integer cents, change in food cost
  allergens: [{ type: String, enum: ALLERGENS }],
  substitution: { type: Boolean, default: false },   // a swap; needs restaurant.orders.substitute if it changes cost or allergens
  removal: { type: Boolean, default: false },
  ingredientLines: [{ _id: false, ingredientId: { type: Schema.Types.ObjectId, ref: 'Ingredient' }, quantity: Number }], // signed, in the ingredient's BASE unit (extra cheese +30, no onions -15)
  soldOut: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
});
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true },
  required: { type: Boolean, default: false },
  min: { type: Number, default: 0, min: 0 },
  max: { type: Number, default: 0, min: 0 },          // 0 = no maximum
  allowQuantity: { type: Boolean, default: false },
  options: { type: [option], default: [] },
  active: { type: Boolean, default: true },
}, { timestamps: true });
s.index({ businessId: 1, name: 1 }, { unique: true });
moneyPaths(s, ['options.priceDelta', 'options.costDelta']);
module.exports = model('ModifierGroup', s);
