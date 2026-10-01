const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

// One line of the closing cash count: e.g. { denomination: 500, count: 7 } = 7 x KES 500.
// `denomination` is whole KES (NOT cents) and `count` a plain integer, so this sub-document
// is intentionally NOT passed through moneyFields. Subtotals are derived (denomination * count).
const denominationLineSchema = new Schema(
  {
    denomination: { type: Number, required: true },
    count: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false }
);

const cashShiftSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    registerId: { type: Schema.Types.ObjectId, ref: 'CashRegister', required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // who opened it
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' }, // who closed it (may differ from cashierId)

    openingCash: { type: Number, required: true, default: 0 }, // integer cents
    closingCash: { type: Number }, // what the system computes: opening + cash sales - cash refunds/payouts
    expectedCash: { type: Number }, // same as closingCash, kept as a separate field for clarity in reports
    actualCash: { type: Number }, // what the cashier physically counted (= sum of denominations)
    cashDifference: { type: Number }, // actualCash - expectedCash (positive = over, negative = short)

    denominations: { type: [denominationLineSchema], default: [] }, // closing count, per note/coin

    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },

    notes: { type: String },
  },
  { timestamps: true }
);

cashShiftSchema.index({ businessId: 1, branchId: 1, status: 1 });
cashShiftSchema.index({ businessId: 1, cashierId: 1, status: 1 });
cashShiftSchema.index({ businessId: 1, openedAt: -1 });

moneyFields(cashShiftSchema, ['openingCash', 'closingCash', 'expectedCash', 'actualCash', 'cashDifference']);

module.exports = model('CashShift', cashShiftSchema);