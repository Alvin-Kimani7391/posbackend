const { Schema, model } = require('mongoose');
const { CALL_KINDS, CALL_STATUS } = require('../constants/hospitality');

/** "Call the waiter" / "request the bill" / "please clean the room" from a QR code (or logged by staff). */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  kind: { type: String, enum: CALL_KINDS, required: true },
  status: { type: String, enum: CALL_STATUS, default: 'OPEN' },
  tableId: { type: Schema.Types.ObjectId, ref: 'RestaurantTable' }, tableName: String,
  roomId: { type: Schema.Types.ObjectId, ref: 'Room' }, roomNumber: String, stayId: { type: Schema.Types.ObjectId, ref: 'Stay' },
  orderId: { type: Schema.Types.ObjectId, ref: 'RestaurantOrder' },
  note: { type: String, trim: true, maxlength: 300 },
  guestName: String,
  source: { type: String, enum: ['GUEST', 'STAFF'], default: 'GUEST' },
  waiterId: Schema.Types.ObjectId,                                     // who was told first (the table's / order's waiter)
  acknowledgedBy: Schema.Types.ObjectId, acknowledgedByName: String, acknowledgedAt: Date,
  resolvedBy: Schema.Types.ObjectId, resolvedAt: Date,
  repeatCount: { type: Number, default: 0 },                           // guest pressed again while it was still open
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, status: 1, createdAt: -1 });
s.index({ businessId: 1, tableId: 1, kind: 1, status: 1 });
s.index({ businessId: 1, roomId: 1, kind: 1, status: 1 });
module.exports = model('ServiceCall', s);
