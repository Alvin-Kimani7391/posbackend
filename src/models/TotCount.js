const { Schema, model } = require('mongoose');
const { TOT_COUNT_TYPES } = require('../constants/liquor');
/** A dip count (measured ml left in open bottles), or a waste / comp pour. Variance = measured - expected. */
const totCountSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  bottleProductId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  type: { type: String, enum: TOT_COUNT_TYPES, required: true },
  expectedMl: { type: Number }, measuredMl: { type: Number },
  varianceMl: { type: Number, required: true }, // COUNT: measured - expected (negative = missing). WASTE / COMP: -ml poured out
  costValue: { type: Number, default: 0 },       // integer cents of the liquid lost (negative) or gained
  reason: { type: String, trim: true, maxlength: 200 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
totCountSchema.index({ businessId: 1, createdAt: -1 });
module.exports = model('TotCount', totCountSchema);
