const { Schema, model } = require('mongoose');
/** One bulk price change (or import update). Keeps every old/new price so it can be reverted. Money is integer cents. */
const priceChangeSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  source: { type: String, enum: ['BULK', 'IMPORT', 'REVERT'], default: 'BULK' },
  field: { type: String, enum: ['sellingPrice', 'costPrice'], required: true },
  summary: { type: String },
  rule: { type: Schema.Types.Mixed },
  items: [{ _id: false, productId: { type: Schema.Types.ObjectId, ref: 'Product' }, name: String, from: Number, to: Number }],
  status: { type: String, enum: ['APPLIED', 'REVERTED'], default: 'APPLIED' },
  revertedAt: { type: Date },
  revertedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
priceChangeSchema.index({ businessId: 1, createdAt: -1 });
module.exports = model('PriceChangeBatch', priceChangeSchema);
