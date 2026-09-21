const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const supplierSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    address: { type: String, trim: true },
    taxPin: { type: String, trim: true },
    contactPerson: { type: String, trim: true },
    paymentTerms: { type: String, trim: true }, // free text, e.g. "Net 30"

    currentBalance: { type: Number, default: 0 }, // integer cents - what THIS BUSINESS owes the supplier (payable)

    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

supplierSchema.index({ businessId: 1, name: 'text' });
supplierSchema.index({ businessId: 1, phone: 1 });

moneyFields(supplierSchema, ['currentBalance']);

module.exports = model('Supplier', supplierSchema);
