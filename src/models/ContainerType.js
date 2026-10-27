const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { CONTAINER_KINDS } = require('../constants/liquor');
/** A returnable container the shop deals in (500ml Tusker bottle, 24-bottle crate...). depositProductId = the service product the till sells to charge the deposit. */
const containerTypeSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  kind: { type: String, enum: CONTAINER_KINDS, default: 'BOTTLE' },
  deposit: { type: Number, default: 0, min: 0 }, // integer cents per container
  depositProductId: { type: Schema.Types.ObjectId, ref: 'Product' },
  emptiesOnHand: { type: Number, default: 0 },   // physical empties in the shop (returned by customers, not yet sent back to the supplier)
  active: { type: Boolean, default: true },
}, { timestamps: true });
containerTypeSchema.index({ businessId: 1, name: 1 }, { unique: true });
moneyFields(containerTypeSchema, ['deposit']);
module.exports = model('ContainerType', containerTypeSchema);
