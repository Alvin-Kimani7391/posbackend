const { Schema, model } = require('mongoose');

/** A recall notice acted on: which batches were held, what was done, and who closed it. Tracing reads the sales/dispensing that touched those batches. */
const recallSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    number: { type: String, required: true },
    noticeReference: { type: String, trim: true },                   // PPB / manufacturer / supplier notice number
    source: { type: String, enum: ['PPB', 'MANUFACTURER', 'SUPPLIER', 'INTERNAL', 'OTHER'], default: 'OTHER' },
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    batchNumber: { type: String, required: true, trim: true },
    reason: { type: String, required: true },
    batchIds: [Schema.Types.ObjectId],
    unitsHeld: { type: Number, default: 0 },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
    actions: { type: [new Schema({ at: Date, by: Schema.Types.ObjectId, action: String, note: String }, { _id: false })], default: [] },
    closedBy: Schema.Types.ObjectId, closedAt: Date, closeNote: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

recallSchema.index({ businessId: 1, number: 1 }, { unique: true });
recallSchema.index({ businessId: 1, status: 1, createdAt: -1 });

module.exports = model('RecallRecord', recallSchema);