const { Schema, model } = require('mongoose');
const { INGREDIENT_LOCATIONS } = require('../constants/restaurant');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  ingredientId: { type: Schema.Types.ObjectId, ref: 'Ingredient', required: true },
  location: { type: String, enum: INGREDIENT_LOCATIONS, default: 'STORE' },
  quantity: { type: Number, default: 0 },   // base units; can go negative only when settings.allowNegativeIngredients
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, ingredientId: 1, location: 1 }, { unique: true });
module.exports = model('IngredientStock', s);
