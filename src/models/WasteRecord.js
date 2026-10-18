const { Schema, model } = require('mongoose');
const C = require('../constants/restaurant');
const moneyPaths = require('../utils/moneyDeepPlugin');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  kind: { type: String, enum: C.WASTE_KINDS, required: true },
  ingredientId: Schema.Types.ObjectId, menuItemId: Schema.Types.ObjectId, orderId: Schema.Types.ObjectId, orderItemId: Schema.Types.ObjectId,
  name: String, quantity: Number, location: String,   // quantity: base units for an ingredient, portions for a dish
  cost: { type: Number, default: 0 },                  // cents
  reason: String, recordedBy: Schema.Types.ObjectId, approvedBy: Schema.Types.ObjectId, createdAt: { type: Date, default: Date.now },
}, { timestamps: false });
s.index({ businessId: 1, branchId: 1, createdAt: -1 });
s.index({ businessId: 1, kind: 1, createdAt: -1 });
moneyPaths(s, ['cost']);
module.exports = model('WasteRecord', s);
