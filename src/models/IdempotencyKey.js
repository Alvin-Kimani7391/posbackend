const { Schema, model } = require('mongoose');

const idempotencyKeySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId },
    route: { type: String, required: true }, // e.g. "POST /sales"
    key: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    responseStatus: { type: Number },
    responseBody: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

idempotencyKeySchema.index({ businessId: 1, route: 1, key: 1 }, { unique: true });
// Pending records older than 2 minutes are treated as abandoned (see middleware) and expire from Mongo automatically.
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // keep 24h for audit/debug

module.exports = model('IdempotencyKey', idempotencyKeySchema);