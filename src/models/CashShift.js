const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const cashShiftSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    registerId: { type: Schema.Types.ObjectId, ref: 'CashRegister', required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    openingCash: { type: Number, required: true, default: 0 }, // integer cents
    closingCash: { type: Number }, // what the system computes: opening + cash sales - cash refunds/payouts
    expectedCash: { type: Number }, // same as closingCash, kept as a separate field for clarity in reports
    actualCash: { type: Number }, // what the cashier physically counted
    cashDifference: { type: Number }, // actualCash - expectedCash (positive = over, negative = short)

    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },

    notes: { type: String },
  },
  { timestamps: true }
);

cashShiftSchema.index({ businessId: 1, branchId: 1, status: 1 });
cashShiftSchema.index({ businessId: 1, cashierId: 1, status: 1 });

moneyFields(cashShiftSchema, ['openingCash', 'closingCash', 'expectedCash', 'actualCash', 'cashDifference']);

module.exports = model('CashShift', cashShiftSchema);
