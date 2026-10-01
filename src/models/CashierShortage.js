const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const SHORTAGE_STATUSES = ['OUTSTANDING', 'PARTIAL', 'CLEARED'];

/**
 * One document per shift that closed SHORT. Created automatically by
 * shift.service#closeShift. `amount` never changes; `amountPaid` / `balance`
 * move as the cashier repays (see ShortagePayment for each repayment).
 */
const cashierShortageSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    shiftId: { type: Schema.Types.ObjectId, ref: 'CashShift', required: true },
    registerId: { type: Schema.Types.ObjectId, ref: 'CashRegister' },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // who ran the drawer (opened the shift)
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    amount: { type: Number, required: true }, // integer cents - the original shortage
    amountPaid: { type: Number, default: 0 }, // integer cents
    balance: { type: Number, required: true }, // integer cents still owed

    status: { type: String, enum: SHORTAGE_STATUSES, default: 'OUTSTANDING' },
    incurredAt: { type: Date, default: Date.now },
    clearedAt: { type: Date },
    clearedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

cashierShortageSchema.index({ shiftId: 1 }, { unique: true }); // one shortage per shift, ever
cashierShortageSchema.index({ businessId: 1, cashierId: 1, status: 1 });
cashierShortageSchema.index({ businessId: 1, branchId: 1, incurredAt: -1 });

moneyFields(cashierShortageSchema, ['amount', 'amountPaid', 'balance']);

const CashierShortage = model('CashierShortage', cashierShortageSchema);
module.exports = CashierShortage;
module.exports.SHORTAGE_STATUSES = SHORTAGE_STATUSES;