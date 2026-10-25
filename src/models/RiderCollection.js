const { Schema, model } = require('mongoose');
const { COLLECTION_STATUS, COLLECTION_ACTIVE } = require('../constants/rider');
/**
 * Money a rider took from a customer at the door (all amounts are integer cents).
 *   CASH   -> HELD (the rider is carrying it) -> HANDED_OVER (the cashier counted it and the bill was paid into the cashier's shift)
 *   MPESA  -> AWAITING_MPESA (STK sent) -> PAID (the bill was settled automatically; the rider never touches the money)
 * One live collection per order (partial unique index below) so a double tap can never take the customer's money twice.
 */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'RestaurantOrder', required: true },
  orderNumber: String,
  riderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  riderName: String,
  customerName: String, customerPhone: String,
  method: { type: String, enum: ['CASH', 'MPESA'], required: true },
  status: { type: String, enum: COLLECTION_STATUS, required: true },
  amount: { type: Number, required: true, min: 1 },
  tendered: Number, change: Number,                                   // CASH: what the customer handed over and the change the rider gave back
  bills: [{ _id: false, billId: Schema.Types.ObjectId, amount: Number }],
  mpesaReference: String, mpesaReceipt: String,
  collectedAt: Date,
  returningAt: Date,                                                  // the rider said "I am bringing the cash back"
  handedOverAt: Date, handoverId: Schema.Types.ObjectId, handoverBy: Schema.Types.ObjectId,
  remindedAt: Date,
  cancelledAt: Date, cancelReason: String,
}, { timestamps: true });
s.index({ businessId: 1, orderId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['AWAITING_MPESA', ...COLLECTION_ACTIVE] } } });
s.index({ businessId: 1, riderId: 1, status: 1 });
s.index({ businessId: 1, branchId: 1, status: 1, collectedAt: -1 });
module.exports = model('RiderCollection', s);
