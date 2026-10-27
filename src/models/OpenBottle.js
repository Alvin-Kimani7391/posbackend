const { Schema, model } = require('mongoose');
/** The "open bottle pool" for one bottle product at one branch: millilitres already poured into stock-less tot sales. Opening a bottle takes 1 from normal stock. */
const openBottleSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  bottleProductId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  volumeMl: { type: Number, required: true },
  openMl: { type: Number, default: 0 },
  bottlesOpened: { type: Number, default: 0 },
}, { timestamps: true });
openBottleSchema.index({ businessId: 1, branchId: 1, bottleProductId: 1 }, { unique: true });
module.exports = model('OpenBottle', openBottleSchema);
