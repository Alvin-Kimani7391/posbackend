const { Schema, model } = require('mongoose');

/**
 * Quarantine for offline sales the server could not turn into a Sale.
 * NOTHING is ever discarded silently: the full payload is kept so the owner can release it
 * (force-accept, flagged) or explicitly discard it (also kept, marked DISCARDED).
 *
 *   HELD      - business reason to wait for a human (e.g. the device was blocked after the sale was made)
 *   REJECTED  - the payload failed a hard check (see `code`); `releasable` says whether force-accept is possible
 *   RELEASED  - accepted later; resultSaleId points at the Sale
 *   DISCARDED - owner/admin decided not to accept it (reason kept)
 */
const syncRejectionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    deviceId: { type: String, required: true },
    deviceCode: { type: String },
    clientTransactionId: { type: String, required: true },
    localSeq: { type: Number },
    soldAt: { type: Date },

    status: { type: String, enum: ['HELD', 'REJECTED', 'RELEASED', 'DISCARDED'], default: 'REJECTED' },
    code: { type: String, required: true },
    message: { type: String },
    releasable: { type: Boolean, default: true },

    payload: { type: Schema.Types.Mixed },
    attempts: { type: Number, default: 1 },
    lastReceivedAt: { type: Date, default: Date.now },

    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
    resolutionNote: { type: String },
    resultSaleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
  },
  { timestamps: true }
);

syncRejectionSchema.index({ businessId: 1, deviceId: 1, clientTransactionId: 1 }, { unique: true });
syncRejectionSchema.index({ businessId: 1, status: 1, createdAt: -1 });

module.exports = model('SyncRejection', syncRejectionSchema);