const { Schema, model } = require('mongoose');
const C = require('../constants/restaurant');
const moneyPaths = require('../utils/moneyDeepPlugin');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  reservationNumber: { type: String, required: true },
  guestName: { type: String, required: true, trim: true }, phone: { type: String, required: true, trim: true }, phoneKey: { type: String, index: true },   // last 9 digits, so 0712 345 678 and +254712345678 are the same guest
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  partySize: { type: Number, required: true, min: 1 },
  startsAt: { type: Date }, durationMinutes: { type: Number, default: 90 }, endsAt: { type: Date },   // waitlist entries have no time yet
  tableIds: [{ type: Schema.Types.ObjectId, ref: 'RestaurantTable' }],
  status: { type: String, enum: C.RESERVATION_STATUS, default: 'BOOKED' },
  source: { type: String, enum: ['PHONE', 'WALK_IN', 'ONLINE', 'STAFF'], default: 'STAFF' },
  occasion: String, notes: String, quotedWaitMinutes: Number,
  preOrder: [{ _id: false, menuItemId: Schema.Types.ObjectId, name: String, quantity: Number, notes: String }],   // dishes the guest chose when booking online, for the kitchen to prepare
  guestEmail: String,
  deposit: {
    required: { type: Boolean, default: false }, amount: { type: Number, default: 0 }, paid: { type: Boolean, default: false },
    method: String, reference: String, paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    appliedBillId: Schema.Types.ObjectId, forfeited: { type: Boolean, default: false }, refunded: { type: Boolean, default: false },
    kind: { type: String, enum: ['DEPOSIT', 'FOOD'], default: 'DEPOSIT' },      // FOOD = money prepaid towards what the guest will eat; it comes off their bill when they dine
    appliedAmount: { type: Number, default: 0 },                                // how much of it has already been used on bills
  },
  arrivedAt: Date, seatedAt: Date, orderId: { type: Schema.Types.ObjectId, ref: 'RestaurantOrder' },
  cancelledAt: Date, cancelReason: String, noShowAt: Date, reminderSentAt: Date, lateAlertedAt: Date, lockedAt: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, startsAt: 1 });
s.index({ businessId: 1, branchId: 1, status: 1, startsAt: 1 });
s.index({ businessId: 1, reservationNumber: 1 }, { unique: true });
s.index({ businessId: 1, tableIds: 1, startsAt: 1, endsAt: 1 });
s.pre('validate', function () { if (this.phone) this.phoneKey = String(this.phone).replace(/\D/g, '').slice(-9); });
moneyPaths(s, ['deposit.amount', 'deposit.appliedAmount']);
module.exports = model('Reservation', s);
