const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const customerSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    address: { type: String, trim: true },
    customerNumber: { type: String, trim: true },

    creditLimit: { type: Number, default: 0 }, // integer cents
    outstandingBalance: { type: Number, default: 0 }, // integer cents - kept in sync by CustomerLedger writes only
    loyaltyPoints: { type: Number, default: 0 },

    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

customerSchema.index({ businessId: 1, phone: 1 });
customerSchema.index({ businessId: 1, customerNumber: 1 }, { unique: true, sparse: true });
customerSchema.index({ businessId: 1, name: 'text' });

moneyFields(customerSchema, ['creditLimit', 'outstandingBalance']);

module.exports = model('Customer', customerSchema);
