const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
/** A cost that repeats (rent, yard rental, subscriptions). `run` creates the expense for each period that has come due, once. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  category: { type: String, required: true }, kind: { type: String, default: 'OPERATING' },
  amount: { type: Number, required: true, min: 1 }, description: { type: String, trim: true, maxlength: 120 }, payee: { type: String, trim: true, maxlength: 80 },
  frequency: { type: String, enum: ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'], required: true },
  nextDue: { type: Date, required: true }, endsOn: Date, active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
schema.index({ businessId: 1, active: 1, nextDue: 1 });
moneyFields(schema, ['amount']);
module.exports = model('RecurringExpense', schema);
