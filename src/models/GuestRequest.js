const { Schema, model } = require('mongoose');
const { GUEST_REQUEST_STATUS } = require('../constants/hospitality');
const moneyPaths = require('../utils/moneyDeepPlugin');

/** An order a guest built after scanning a QR code. It becomes a real order (and kitchen tickets) only when accepted or auto-accepted. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  kind: { type: String, enum: ['TABLE', 'ROOM'], required: true },
  tableId: { type: Schema.Types.ObjectId, ref: 'RestaurantTable' }, tableName: String,
  roomId: { type: Schema.Types.ObjectId, ref: 'Room' }, roomNumber: String, stayId: { type: Schema.Types.ObjectId, ref: 'Stay' },
  status: { type: String, enum: GUEST_REQUEST_STATUS, default: 'PENDING' },
  items: [{
    _id: false, menuItemId: { type: Schema.Types.ObjectId, ref: 'MenuItem', required: true }, name: String, quantity: { type: Number, required: true, min: 0.001 },
    variantId: Schema.Types.ObjectId, modifiers: [{ _id: false, groupId: Schema.Types.ObjectId, optionId: Schema.Types.ObjectId, quantity: { type: Number, default: 1 } }],
    comboPicks: [{ _id: false, groupName: String, menuItemId: Schema.Types.ObjectId, variantId: Schema.Types.ObjectId, quantity: { type: Number, default: 1 } }],
    notes: String, allergyNotes: String, unitPriceEstimate: Number,
  }],
  guest: { name: String, phone: String },
  accountId: { type: Schema.Types.ObjectId, ref: 'GuestAccount', index: true },   // set when the guest was signed in
  notes: String,
  estimatedTotal: { type: Number, default: 0 },                       // what the guest saw; the real price is recomputed on acceptance
  mode: { type: String, enum: ['CONFIRM', 'AUTO'], default: 'CONFIRM' },
  clientRef: String,                                                  // the guest's device sends one per submission: a double tap never makes two orders
  orderId: { type: Schema.Types.ObjectId, ref: 'RestaurantOrder' },
  decision: { by: Schema.Types.ObjectId, byName: String, at: Date, reason: String },
  failure: String,
  ipHash: String,
  expiresAt: Date,
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, status: 1, createdAt: -1 });
s.index({ businessId: 1, clientRef: 1 }, { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } } });
s.index({ status: 1, expiresAt: 1 });
moneyPaths(s, ['estimatedTotal', 'items.unitPriceEstimate']);
module.exports = model('GuestRequest', s);
