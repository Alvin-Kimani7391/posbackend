const { Schema, model } = require('mongoose');
/**
 * Links a signed-in customer to what they placed from the storefront (a delivery order, a table reservation or a room booking) and
 * tracks the "pay first" step: AWAITING (M-PESA not paid yet, the item is only held until payBy) -> PAID, or EXPIRED (released).
 * Kept apart from the order / reservation / stay documents so the POS screens staff already use are not touched.
 */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'GuestAccount', index: true },
  kind: { type: String, enum: ['ORDER', 'RESERVATION', 'STAY'], required: true },
  refId: { type: Schema.Types.ObjectId, required: true },
  reference: { type: String, required: true },                 // track key (ORDER), RS-00012 (RESERVATION) or booking code (STAY)
  phone: String,
  payState: { type: String, enum: ['NONE', 'COD', 'AWAITING', 'PAID', 'EXPIRED'], default: 'NONE' },
  amountDue: { type: Number, default: 0 },                     // cents
  payBy: Date,
  receiptRef: String,                                          // the M-PESA request reference of the payment that settled it
}, { timestamps: true });
s.index({ businessId: 1, kind: 1, refId: 1 }, { unique: true });
s.index({ payState: 1, payBy: 1 });
module.exports = model('StoreBooking', s);
