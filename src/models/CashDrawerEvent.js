const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { DRAWER_EVENT_TYPES } = require('../constants/cashier');

/**
 * Everything that happens at the cash drawer that is NOT a sale payment:
 *   NO_SALE   drawer opened without a sale (needs a reason, management is told)
 *   PAID_IN   cash put in (float top-up, change from the safe)
 *   PAID_OUT  cash taken out for an expense / supplier (needs a reason, management is told)
 *   SAFE_DROP cash moved from the drawer to the safe
 *   CASH_SALE the drawer popped to give change for a cash payment (audit trail only, amount 0)
 * PAID_IN / PAID_OUT / SAFE_DROP change the shift's expected cash (see shift.service closeShift).
 * Amounts are integer cents like every other money field.
 */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  shiftId: { type: Schema.Types.ObjectId, ref: 'CashShift', required: true, index: true },
  registerId: { type: Schema.Types.ObjectId, ref: 'CashRegister' },
  type: { type: String, enum: DRAWER_EVENT_TYPES, required: true },
  amount: { type: Number, default: 0, min: 0 },
  reason: { type: String, trim: true, maxlength: 300 },
  reference: { type: String, trim: true, maxlength: 80 },          // bill number / receipt number / voucher the movement belongs to
  billId: { type: Schema.Types.ObjectId },
  by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  byName: String,
}, { timestamps: true });

s.index({ businessId: 1, shiftId: 1, createdAt: -1 });
s.index({ businessId: 1, branchId: 1, createdAt: -1 });
moneyFields(s, ['amount']);

const SIGN = { PAID_IN: 1, PAID_OUT: -1, SAFE_DROP: -1 };

/** Net effect of the movements on a shift's drawer, in cents (+ in, - out). Never throws: a failure here must not block closing a shift. */
s.statics.netForShift = async function netForShift(shiftId) {
  try {
    const rows = await this.aggregate([{ $match: { shiftId, type: { $in: Object.keys(SIGN) } } }, { $group: { _id: '$type', total: { $sum: '$amount' } } }]);
    return rows.reduce((sum, r) => sum + (SIGN[r._id] || 0) * r.total, 0);
  } catch (e) { console.error('[cash drawer] could not total movements:', e.message); return 0; }
};

module.exports = model('CashDrawerEvent', s);
module.exports.SIGN = SIGN;
