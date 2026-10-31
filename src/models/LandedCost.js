const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { LANDED_TYPES } = require('../constants/hardware');
/** Freight, offloading, handling... paid to bring a purchase in. Spread over the purchase lines (by value or by quantity) for a landed unit cost. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
  type: { type: String, enum: LANDED_TYPES, required: true },
  amount: { type: Number, required: true, min: 1 },
  allocateBy: { type: String, enum: ['VALUE', 'QUANTITY'], default: 'VALUE' },
  payee: { type: String, trim: true, maxlength: 80 }, reference: { type: String, trim: true, maxlength: 60 },
  expenseId: { type: Schema.Types.ObjectId, ref: 'Expense' },
  date: { type: Date, default: Date.now }, note: { type: String, trim: true, maxlength: 200 },
  voided: { type: Boolean, default: false }, voidReason: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, purchaseId: 1 });
moneyFields(schema, ['amount']);
module.exports = model('LandedCost', schema);
