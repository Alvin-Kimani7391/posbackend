const { Schema, model } = require('mongoose');
const { DEFAULTS } = require('../constants/rider');
/** Route breadcrumbs for one delivery. Kept for a week (TTL) then removed by MongoDB itself. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, required: true },
  orderId: { type: Schema.Types.ObjectId, required: true },
  riderId: { type: Schema.Types.ObjectId, required: true },
  lat: { type: Number, required: true }, lng: { type: Number, required: true },
  accuracy: Number, speed: Number, heading: Number,
  at: { type: Date, default: Date.now, index: { expireAfterSeconds: DEFAULTS.trailKeepDays * 86400 } },
}, { versionKey: false });
s.index({ orderId: 1, at: 1 });
module.exports = model('RiderLocationPoint', s);
