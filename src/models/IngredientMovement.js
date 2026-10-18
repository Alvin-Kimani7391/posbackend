const { Schema, model } = require('mongoose');
const { INGREDIENT_LOCATIONS, INGREDIENT_MOVEMENT_TYPES } = require('../constants/restaurant');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  ingredientId: { type: Schema.Types.ObjectId, ref: 'Ingredient', required: true },
  location: { type: String, enum: INGREDIENT_LOCATIONS, default: 'STORE' },
  type: { type: String, enum: INGREDIENT_MOVEMENT_TYPES, required: true },
  quantity: { type: Number, required: true },       // signed, base units
  previousQty: { type: Number, required: true },
  newQty: { type: Number, required: true },
  unitCost: { type: Number, default: 0 },            // cents per base unit at the time
  value: { type: Number, default: 0 },               // cents, |quantity| x unitCost
  batchId: { type: Schema.Types.ObjectId, ref: 'IngredientBatch' },
  referenceType: String, referenceId: Schema.Types.ObjectId, reason: String,
  performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: false });
s.index({ businessId: 1, branchId: 1, ingredientId: 1, createdAt: -1 });
s.index({ businessId: 1, referenceType: 1, referenceId: 1 });
s.index({ businessId: 1, type: 1, createdAt: -1 });
s.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function blockUpdate(next) { next(new Error('IngredientMovement records are immutable')); });
s.pre(['deleteOne', 'findOneAndDelete', 'deleteMany'], function blockDelete(next) { next(new Error('IngredientMovement records are immutable')); });
module.exports = model('IngredientMovement', s);
