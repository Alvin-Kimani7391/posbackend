const { Schema, model } = require('mongoose');
const { ALLERGENS } = require('../constants/restaurant');
const { UNIT_NAMES } = require('../utils/restaurantUnits');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true },
  sku: { type: String, trim: true, uppercase: true },
  baseUnit: { type: String, enum: ['g', 'ml', 'piece'], required: true },           // every stored quantity is in this unit
  purchaseUnit: { type: String, enum: UNIT_NAMES },                                  // how it is usually bought (kg, litre, dozen...)
  costPerBase: { type: Number, default: 0, min: 0 },                                 // CENTS per base unit (g/ml/piece), may be fractional: this is NOT run through the money plugin
  lowStockLevel: { type: Number, default: 0, min: 0 },                               // base units, branch-wide per location total
  reorderLevel: { type: Number, default: 0, min: 0 },
  parLevel: { type: Number, default: 0, min: 0 },                                    // level to order up to
  trackBatch: { type: Boolean, default: false },
  shelfLifeDays: { type: Number, min: 0 },
  supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
  allergens: [{ type: String, enum: ALLERGENS }],
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
}, { timestamps: true });
s.index({ businessId: 1, name: 1 }, { unique: true });
s.index({ businessId: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: 'string' } } });
module.exports = model('Ingredient', s);
