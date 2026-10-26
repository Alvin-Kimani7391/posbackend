const { Schema, model } = require('mongoose');

/**
 * Ledger of every operation a restaurant / accommodation device replayed after being offline.
 * One row per (business, device, clientOpId): that is the idempotency guarantee, so a replay after a dropped
 * connection or a crash never applies the same tap twice. `result` carries the server ids the device needs to map
 * its local ids (orderId, billId, receiptNumber...) and `occurredAt` keeps WHEN it really happened on the device.
 */
const offlineOpSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
  deviceId: { type: String, required: true },
  clientOpId: { type: String, required: true },
  seq: { type: Number },
  type: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['PENDING', 'APPLIED', 'CONFLICT'], default: 'PENDING' },
  occurredAt: { type: Date },
  syncedAt: { type: Date },
  skewMs: { type: Number },
  code: String,
  message: String,
  result: { type: Schema.Types.Mixed },
  payload: { type: Schema.Types.Mixed },
  reviewed: { type: Boolean, default: false },       // a manager acknowledged a CONFLICT
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
}, { timestamps: true });

offlineOpSchema.index({ businessId: 1, deviceId: 1, clientOpId: 1 }, { unique: true });
offlineOpSchema.index({ businessId: 1, status: 1, createdAt: -1 });
offlineOpSchema.index({ businessId: 1, branchId: 1, 'result.billId': 1 }, { sparse: true });
offlineOpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });   // keep 6 months

module.exports = model('OfflineOp', offlineOpSchema);
