const { Schema, model } = require('mongoose');
/** A contractor's job / site. Quotations, orders and deliveries hang off it for project history and profitability. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  code: { type: String, trim: true, uppercase: true, maxlength: 30 },
  siteAddress: { type: String, trim: true, maxlength: 250 },
  poNumber: { type: String, trim: true, maxlength: 60 },
  status: { type: String, enum: ['ACTIVE', 'CLOSED'], default: 'ACTIVE' },
  notes: { type: String, trim: true, maxlength: 300 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
schema.index({ businessId: 1, customerId: 1, status: 1 });
schema.index({ businessId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
module.exports = model('Project', schema);
