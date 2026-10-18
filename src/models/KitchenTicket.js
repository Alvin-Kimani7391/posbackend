const { Schema, model } = require('mongoose');
const C = require('../constants/restaurant');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'RestaurantOrder', required: true },
  orderNumber: String, ticketNumber: { type: String, required: true },
  stationId: { type: Schema.Types.ObjectId, ref: 'KitchenStation' }, stationName: String, stationCode: String,
  tableName: String, waiterName: String, orderType: String, guestCount: Number, pickupNumber: String,
  type: { type: String, enum: C.TICKET_TYPES, default: 'NEW' },
  status: { type: String, enum: C.TICKET_STATUS, default: 'NEW' },
  priority: { type: String, enum: C.TICKET_PRIORITY, default: 'NORMAL' },
  allergyAlert: { type: Boolean, default: false },
  notes: String,
  items: [{
    _id: false, orderItemId: Schema.Types.ObjectId, name: String, variantName: String, quantity: Number, modifiersText: String, notes: String,
    allergyNotes: String, allergens: [String], course: Number, seatNumber: Number, isComp: Boolean, parentItemId: Schema.Types.ObjectId,
    status: { type: String, enum: C.ITEM_STATUS }, cancelled: { type: Boolean, default: false }, cancelReason: String, prepMinutes: Number,
    acceptedAt: Date, preparingAt: Date, readyAt: Date,
  }],
  receivedAt: { type: Date, default: Date.now }, acceptedAt: Date, preparingAt: Date, readyAt: Date, completedAt: Date,
  expoConfirmedAt: Date, expoConfirmedBy: Schema.Types.ObjectId,
  delayAlertedAt: Date,
  printCount: { type: Number, default: 0 },
  reprints: [{ _id: false, at: Date, by: Schema.Types.ObjectId, reason: String }],
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, status: 1, receivedAt: 1 });
s.index({ businessId: 1, orderId: 1 });
s.index({ businessId: 1, branchId: 1, ticketNumber: 1 }, { unique: true });
module.exports = model('KitchenTicket', s);
