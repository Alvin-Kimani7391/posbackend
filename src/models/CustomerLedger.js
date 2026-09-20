const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const customerLedgerSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },

    transactionType: { type: String, enum: ['SALE_CREDIT', 'PAYMENT', 'ADJUSTMENT', 'REVERSAL'], required: true },
    referenceType: { type: String }, // 'Sale', 'Payment', 'Refund'
    referenceId: { type: Schema.Types.ObjectId },

    debit: { type: Number, default: 0 },  // integer cents - increases what the customer owes
    credit: { type: Number, default: 0 }, // integer cents - decreases what the customer owes
    balance: { type: Number, required: true }, // integer cents - running balance AFTER this entry

    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

customerLedgerSchema.index({ businessId: 1, customerId: 1, createdAt: -1 });

customerLedgerSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function blockUpdate(next) {
  next(new Error('CustomerLedger records are immutable and cannot be updated'));
});
customerLedgerSchema.pre(['deleteOne', 'findOneAndDelete', 'deleteMany'], function blockDelete(next) {
  next(new Error('CustomerLedger records are immutable and cannot be deleted'));
});

moneyFields(customerLedgerSchema, ['debit', 'credit', 'balance']);

module.exports = model('CustomerLedger', customerLedgerSchema);
