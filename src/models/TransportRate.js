const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { RATE_COMPONENTS, RATE_BASIS, VEHICLE_TYPES } = require('../constants/hardware');
/** One price rule. Only ONE rate per component is ever applied to a job, so a charge can never be added twice. value = cents per `basis` unit. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  component: { type: String, enum: RATE_COMPONENTS, required: true },
  basis: { type: String, enum: RATE_BASIS, required: true },
  value: { type: Number, required: true, min: 0 },
  minCharge: { type: Number, default: 0, min: 0 },
  zone: { type: String, trim: true, lowercase: true, maxlength: 60 },
  vehicleType: { type: String, enum: VEHICLE_TYPES },
  active: { type: Boolean, default: true },
  notes: { type: String, trim: true, maxlength: 200 },
}, { timestamps: true });
schema.index({ businessId: 1, component: 1, active: 1 });
moneyFields(schema, ['value', 'minCharge']);
module.exports = model('TransportRate', schema);
