const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
  month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  category: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
}, { timestamps: true });
schema.index({ businessId: 1, branchId: 1, month: 1, category: 1 }, { unique: true });
moneyFields(schema, ['amount']);
module.exports = model('ExpenseBudget', schema);
