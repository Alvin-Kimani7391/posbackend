const { Schema, model } = require('mongoose');
const moneyPaths = require('../utils/moneyDeepPlugin');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  purchaseNumber: { type: String, required: true },
  supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' }, invoiceNumber: String,
  lines: [{ _id: false, ingredientId: Schema.Types.ObjectId, name: String, location: String, purchaseQuantity: Number, purchaseUnit: String, baseQuantity: Number, costPerBase: Number, lineTotal: Number, batchNumber: String, expiryDate: Date }],
  total: { type: Number, default: 0 }, amountPaid: { type: Number, default: 0 },
  status: { type: String, enum: ['RECEIVED'], default: 'RECEIVED' },
  notes: String, receivedBy: Schema.Types.ObjectId, receivedAt: { type: Date, default: Date.now },
}, { timestamps: true });
s.index({ businessId: 1, purchaseNumber: 1 }, { unique: true });
s.index({ businessId: 1, branchId: 1, receivedAt: -1 });
moneyPaths(s, ['total', 'amountPaid', 'lines.lineTotal']);
module.exports = model('IngredientPurchase', s);
