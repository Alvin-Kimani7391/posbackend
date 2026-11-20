const { Schema, model } = require('mongoose');

/** Idempotency marker for offline STOCK_RECEIVE / STOCK_ADJUST events: a re-sent event never moves stock twice. */
const offlineStockEventSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    deviceId: { type: String, required: true },
    clientEventId: { type: String, required: true },
    eventType: { type: String, enum: ['STOCK_RECEIVE', 'STOCK_ADJUST'], required: true },
  },
  { timestamps: true }
);
offlineStockEventSchema.index({ businessId: 1, deviceId: 1, clientEventId: 1 }, { unique: true });

module.exports = model('OfflineStockEvent', offlineStockEventSchema);
