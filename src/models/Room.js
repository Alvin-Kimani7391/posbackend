const { Schema, model } = require('mongoose');
const { ROOM_STATUS, HOUSEKEEPING_STATUS } = require('../constants/hospitality');

const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  roomTypeId: { type: Schema.Types.ObjectId, ref: 'RoomType', required: true },
  number: { type: String, required: true, trim: true },               // "101", "Cottage 3"
  name: { type: String, trim: true },
  floor: { type: String, trim: true },
  status: { type: String, enum: ROOM_STATUS, default: 'AVAILABLE' },
  housekeeping: { type: String, enum: HOUSEKEEPING_STATUS, default: 'CLEAN' },
  currentStayId: { type: Schema.Types.ObjectId, ref: 'Stay', default: null },
  outOfOrder: { reason: String, since: Date, until: Date, by: Schema.Types.ObjectId },
  notes: { type: String, trim: true },
  lastCleanedAt: Date, lastInspectedAt: Date,
  qrVersion: { type: Number, default: 1 },                           // bump to invalidate every printed QR for this room
  qrEnabled: { type: Boolean, default: true },
  bookingSeq: { type: Number, default: 0 },                          // incremented inside every booking transaction: two concurrent bookings of one room conflict instead of both succeeding
  active: { type: Boolean, default: true },
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, number: 1 }, { unique: true });
s.index({ businessId: 1, branchId: 1, status: 1 });
module.exports = model('Room', s);
