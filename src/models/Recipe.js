const { Schema, model } = require('mongoose');
const { UNIT_NAMES } = require('../utils/restaurantUnits');
const moneyPaths = require('../utils/moneyDeepPlugin');
/** Recipes are VERSIONED: an edit creates a new version and retires the old one; orders snapshot the version in force. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  menuItemId: { type: Schema.Types.ObjectId, ref: 'MenuItem', required: true },
  version: { type: Number, required: true },
  isCurrent: { type: Boolean, default: true },
  yieldPortions: { type: Number, default: 1, min: 0.01 },   // portions the listed quantities produce (batch recipes)
  lines: [{
    _id: false,
    ingredientId: { type: Schema.Types.ObjectId, ref: 'Ingredient', required: true },
    quantity: { type: Number, required: true, min: 0 },     // BASE unit (g/ml/piece), for the whole yield
    displayQuantity: Number, displayUnit: { type: String, enum: UNIT_NAMES },
    prepLossPercent: { type: Number, default: 0, min: 0, max: 95 }, // trimming / cooking loss: consumption = quantity / (1 - loss)
    optional: { type: Boolean, default: false },
  }],
  costPerPortion: { type: Number, default: 0 },              // cents, snapshot at creation
  changeNote: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
s.index({ businessId: 1, menuItemId: 1, version: -1 }, { unique: true });
s.index({ businessId: 1, menuItemId: 1, isCurrent: 1 });
s.index({ businessId: 1, 'lines.ingredientId': 1, isCurrent: 1 });
moneyPaths(s, ['costPerPortion']);
module.exports = model('Recipe', s);
