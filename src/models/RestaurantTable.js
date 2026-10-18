const { Schema, model } = require('mongoose');
const { TABLE_STATUS } = require('../constants/restaurant');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  areaId: { type: Schema.Types.ObjectId, ref: 'RestaurantArea' },
  name: { type: String, required: true, trim: true },
  seats: { type: Number, default: 4, min: 1, max: 100 },
  status: { type: String, enum: TABLE_STATUS, default: 'AVAILABLE' },
  statusSince: { type: Date, default: Date.now },
  waiterId: { type: Schema.Types.ObjectId, ref: 'User' },                         // waiter assigned to the table
  currentOrderId: { type: Schema.Types.ObjectId, ref: 'RestaurantOrder', default: null },
  guestCount: { type: Number, default: 0 },
  seatedAt: { type: Date },
  combinedInto: { type: Schema.Types.ObjectId, ref: 'RestaurantTable', default: null }, // set on secondary tables of a combined group
  combinedWith: [{ type: Schema.Types.ObjectId, ref: 'RestaurantTable' }],               // set on the primary table
  position: { x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, shape: { type: String, default: 'SQUARE' } },
  qrVersion: { type: Number, default: 1 },                                            // bump to invalidate every printed QR for this table
  qrEnabled: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, name: 1 }, { unique: true });
s.index({ businessId: 1, branchId: 1, status: 1 });
module.exports = model('RestaurantTable', s);
