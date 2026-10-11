const { Schema, model } = require('mongoose');

const etimsTransactionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    invoiceNumber: { type: String, required: true },

    requestPayload: { type: Schema.Types.Mixed },
    responsePayload: { type: Schema.Types.Mixed },

    externalReference: { type: String }, // DigiTax's sale_id
    // Mirrors DigiTax's own transaction statuses (see docs) so the mapping
    // stays obvious when debugging: PENDING (queued), SUBMITTED (rare -
    // DigiTax synced but doesn't have final KRA data yet), COMPLETED (KRA
    // accepted - etims_url/signature available), FAILED (KRA rejected).
    status: { type: String, enum: ['PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED'], default: 'PENDING' },

    errorCode: { type: String },
    errorMessage: { type: String },

    submittedAt: { type: Date, default: Date.now },
    confirmedAt: { type: Date },
    retryCount: { type: Number, default: 0 },

    // Short-lived claim so the post-commit kick and the cron can never submit the same invoice at once.
    lockedUntil: { type: Date },
  },
  { timestamps: true }
);

etimsTransactionSchema.index({ businessId: 1, saleId: 1 }, { unique: true });
etimsTransactionSchema.index({ status: 1, retryCount: 1 });
etimsTransactionSchema.index({ status: 1, updatedAt: 1 }); // retry sweep

module.exports = model('EtimsTransaction', etimsTransactionSchema);