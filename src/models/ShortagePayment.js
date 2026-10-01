const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const SHORTAGE_PAYMENT_METHODS = ['CASH', 'MPESA', 'BANK', 'SALARY_DEDUCTION', 'OTHER'];

// One repayment by a cashier against a CashierShortage.
const shortagePaymentSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    shortageId: { type: Schema.Types.ObjectId, ref: 'CashierShortage', required: true, index: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    amount: { type: Number, required: true }, // integer cents
    balanceAfter: { type: Number, required: true }, // integer cents owed after this payment
    method: { type: String, enum: SHORTAGE_PAYMENT_METHODS, default: 'CASH' },
    reference: { type: String, trim: true },
    notes: { type: String, trim: true },

    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // the manager/owner who recorded it
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

moneyFields(shortagePaymentSchema, ['amount', 'balanceAfter']);

const ShortagePayment = model('ShortagePayment', shortagePaymentSchema);
module.exports = ShortagePayment;
module.exports.SHORTAGE_PAYMENT_METHODS = SHORTAGE_PAYMENT_METHODS;