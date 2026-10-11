const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const SHORTAGE_STATUSES = ['OUTSTANDING', 'PARTIAL', 'CLEARED'];
const SHORTAGE_KINDS = ['CASH_SHORTAGE', 'MPESA_REJECTED'];

/**
 * One document per shift that closed SHORT (kind CASH_SHORTAGE, created by shift.service#closeShift),
 * OR per rejected offline M-PESA payment the manager charged to the cashier (kind MPESA_REJECTED, no shiftId).
 * `amount` never changes; `amountPaid` / `balance` move as the cashier repays (see ShortagePayment).
 */
const cashierShortageSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    kind: { type: String, enum: SHORTAGE_KINDS, default: 'CASH_SHORTAGE' },
    shiftId: { type: Schema.Types.ObjectId, ref: 'CashShift', required: function requiredShift() { return this.kind !== 'MPESA_REJECTED'; } },
    claimId: { type: Schema.Types.ObjectId, ref: 'OfflineMpesaClaim' },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    note: { type: String },
    registerId: { type: Schema.Types.ObjectId, ref: 'CashRegister' },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    amount: { type: Number, required: true }, // integer cents
    amountPaid: { type: Number, default: 0 },
    balance: { type: Number, required: true },

    status: { type: String, enum: SHORTAGE_STATUSES, default: 'OUTSTANDING' },
    incurredAt: { type: Date, default: Date.now },
    clearedAt: { type: Date },
    clearedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Partial: M-PESA debts have no shiftId, so only real ObjectIds are indexed (one shortage per shift, ever).
cashierShortageSchema.index({ shiftId: 1 }, { unique: true, partialFilterExpression: { shiftId: { $type: 'objectId' } } });
cashierShortageSchema.index({ claimId: 1 }, { unique: true, partialFilterExpression: { claimId: { $type: 'objectId' } } });
cashierShortageSchema.index({ businessId: 1, cashierId: 1, status: 1 });
cashierShortageSchema.index({ businessId: 1, branchId: 1, incurredAt: -1 });

moneyFields(cashierShortageSchema, ['amount', 'amountPaid', 'balance']);

const CashierShortage = model('CashierShortage', cashierShortageSchema);
module.exports = CashierShortage;
module.exports.SHORTAGE_STATUSES = SHORTAGE_STATUSES;
module.exports.SHORTAGE_KINDS = SHORTAGE_KINDS;