const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
/** Money a customer paid in advance (against a project / order). It is a LIABILITY until applied to an invoice, never sales revenue or cash from a sale. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' }, quotationId: { type: Schema.Types.ObjectId, ref: 'Quotation' },
  number: { type: String, required: true },
  amount: { type: Number, required: true, min: 1 }, balance: { type: Number, required: true, min: 0 },
  method: { type: String, enum: ['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER'], required: true },
  reference: { type: String, trim: true, maxlength: 60 },
  applications: [{ _id: false, saleId: Schema.Types.ObjectId, amount: Number, at: Date }],
  refunds: [{ _id: false, amount: Number, reason: String, at: Date, by: Schema.Types.ObjectId }],
  status: { type: String, enum: ['OPEN', 'USED', 'REFUNDED'], default: 'OPEN' },
  notes: { type: String, trim: true, maxlength: 200 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, number: 1 }, { unique: true });
schema.index({ businessId: 1, reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } } }); // one provider reference can only be recorded once
schema.index({ businessId: 1, customerId: 1, status: 1 });
moneyFields(schema, ['amount', 'balance'], { applications: ['amount'], refunds: ['amount'] });
module.exports = model('CustomerDeposit', schema);
