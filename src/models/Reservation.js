const { Schema, model } = require('mongoose');
const C = require('../constants/restaurant');
const moneyPaths = require('../utils/moneyDeepPlugin');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  reservationNumber: { type: String, required: true },
  guestName: { type: String, required: true, trim: true }, phone: { type: String, required: true, trim: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  partySize: { type: Number, required: true, min: 1 },
  startsAt: { type: Date }, durationMinutes: { type: Number, default: 90 }, endsAt: { type: Date },   // waitlist entries have no time yet
  tableIds: [{ type: Schema.Types.ObjectId, ref: 'RestaurantTable' }],
  status: { type: String, enum: C.RESERVATION_STATUS, default: 'BOOKED' },
  source: { type: String, enum: ['PHONE', 'WALK_IN', 'ONLINE', 'STAFF'], default: 'STAFF' },
  occasion: String, notes: String, quotedWaitMinutes: Number,
  deposit: {
    required: { type: Boolean, default: false }, amount: { type: Number, default: 0 }, paid: { type: Boolean, default: false },
    method: String, reference: String, paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    appliedBillId: Schema.Types.ObjectId, forfeited: { type: Boolean, default: false }, refunded: { type: Boolean, default: false },
  },
  arrivedAt: Date, seatedAt: Date, orderId: { type: Schema.Types.ObjectId, ref: 'RestaurantOrder' },
  cancelledAt: Date, cancelReason: String, noShowAt: Date, reminderSentAt: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, startsAt: 1 });
s.index({ businessId: 1, branchId: 1, status: 1, startsAt: 1 });
s.index({ businessId: 1, reservationNumber: 1 }, { unique: true });
s.index({ businessId: 1, tableIds: 1, startsAt: 1, endsAt: 1 });
moneyPaths(s, ['deposit.amount']);
module.exports = model('Reservation', s);
