const { Schema, model } = require('mongoose');
/** What a tot sale poured, so a cancel or refund can put it back. */
const totDrawSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
  totProductId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  bottleProductId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  tots: { type: Number, required: true },       // tots sold
  mlPerTot: { type: Number, required: true },
  restoredTots: { type: Number, default: 0 },   // already put back by cancels / refunds
  bottlesOpened: { type: Number, default: 0 },
}, { timestamps: true });
totDrawSchema.index({ saleId: 1, totProductId: 1 });
module.exports = model('TotDraw', totDrawSchema);
