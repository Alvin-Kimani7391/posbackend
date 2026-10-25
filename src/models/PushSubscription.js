const { Schema, model } = require('mongoose');
/** A browser's Web Push subscription. CUSTOMER subscriptions belong to one delivery (trackKey); STAFF ones to a user (riders, cashiers, managers). */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, required: true, index: true },
  audience: { type: String, enum: ['CUSTOMER', 'STAFF'], required: true },
  trackKey: { type: String, index: true },
  userId: { type: Schema.Types.ObjectId, index: true },
  endpoint: { type: String, required: true },
  keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
  userAgent: String,
  failures: { type: Number, default: 0 },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },        // customer subscriptions die with the delivery
}, { timestamps: true });
s.index({ endpoint: 1 }, { unique: true });
module.exports = model('PushSubscription', s);
