const { Schema, model } = require('mongoose');
/**
 * One document per rider: are they on duty, and where were they last seen. The live board, the customer's map and the
 * "rider went quiet" job all read this. The route line lives in RiderLocationPoint, never here.
 */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  riderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  riderName: String,
  branchIds: [Schema.Types.ObjectId],
  online: { type: Boolean, default: false },
  onlineSince: Date,
  lastSeenAt: Date,
  location: { lat: Number, lng: Number, accuracy: Number, heading: Number, speed: Number, at: Date },     // speed in m/s
  battery: { level: Number, charging: Boolean },
  device: String,
  trailLast: { lat: Number, lng: Number, at: Date },        // the last point kept for the route line (throttle)
  quietNotifiedAt: Date,                                     // set when management was told the rider went quiet mid-delivery
}, { timestamps: true });
s.index({ businessId: 1, riderId: 1 }, { unique: true });
s.index({ businessId: 1, online: 1, lastSeenAt: -1 });
module.exports = model('RiderPresence', s);
