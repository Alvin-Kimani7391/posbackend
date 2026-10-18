const { Schema, model } = require('mongoose');
const C = require('../constants/restaurant');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  countNumber: { type: String, required: true },
  location: { type: String, enum: C.INGREDIENT_LOCATIONS, default: 'STORE' },
  status: { type: String, enum: ['OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED'], default: 'OPEN' },
  lines: [{ ingredientId: Schema.Types.ObjectId, name: String, baseUnit: String, systemQty: Number, countedQty: Number, variance: Number, reason: String }],
  startedBy: Schema.Types.ObjectId, submittedBy: Schema.Types.ObjectId, approvedBy: Schema.Types.ObjectId, submittedAt: Date, approvedAt: Date, notes: String,
}, { timestamps: true });
s.index({ businessId: 1, countNumber: 1 }, { unique: true });
s.index({ businessId: 1, branchId: 1, status: 1 });
module.exports = model('IngredientCount', s);
