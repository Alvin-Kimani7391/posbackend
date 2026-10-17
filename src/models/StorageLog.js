const { Schema, model } = require('mongoose');

/** A temperature reading for a storage place (fridge, dispensary shelf). Out of range -> flagged batches are quarantined until assessed. */
const storageLogSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    place: { type: String, required: true, trim: true },           // "Fridge 1"
    readingC: { type: Number, required: true },
    minC: { type: Number, required: true },
    maxC: { type: Number, required: true },
    withinRange: { type: Boolean, required: true },
    note: String,
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    exception: {
      type: new Schema({
        status: { type: String, enum: ['OPEN', 'ASSESSED'], default: 'OPEN' },
        batchIds: [Schema.Types.ObjectId],
        assessedBy: Schema.Types.ObjectId, assessedAt: Date,
        outcome: { type: String, enum: ['RELEASED', 'DISPOSED', 'PARTIAL'] },
        assessmentNote: String,
      }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true }
);

storageLogSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });
storageLogSchema.index({ businessId: 1, 'exception.status': 1 });

module.exports = model('StorageLog', storageLogSchema);