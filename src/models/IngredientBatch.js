const { Schema, model } = require('mongoose');
const { INGREDIENT_LOCATIONS } = require('../constants/restaurant');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  ingredientId: { type: Schema.Types.ObjectId, ref: 'Ingredient', required: true },
  location: { type: String, enum: INGREDIENT_LOCATIONS, default: 'STORE' },
  batchNumber: { type: String, required: true, trim: true },
  expiryDate: { type: Date },
  receivedAt: { type: Date, default: Date.now },
  initialQuantity: { type: Number, required: true },
  quantity: { type: Number, required: true },       // remaining, base units
  costPerBase: { type: Number, default: 0 },
  supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
  status: { type: String, enum: ['ACTIVE', 'EXHAUSTED', 'EXPIRED', 'DISCARDED'], default: 'ACTIVE' },
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, ingredientId: 1, location: 1, status: 1, expiryDate: 1 });
s.index({ businessId: 1, branchId: 1, ingredientId: 1, location: 1, batchNumber: 1 }, { unique: true });
module.exports = model('IngredientBatch', s);
