const { Schema, model } = require('mongoose');
const { VEHICLE_TYPES, OWNERSHIP, VEHICLE_STATUS } = require('../constants/hardware');
/** A truck / pickup used for transport jobs (owned, leased or hired). Not the garage customer `Vehicle`. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
  plate: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
  name: { type: String, trim: true, maxlength: 60 },
  type: { type: String, enum: VEHICLE_TYPES, default: 'PICKUP' },
  capacityKg: { type: Number, min: 0, default: 0 }, capacityM3: { type: Number, min: 0, default: 0 },
  ownership: { type: String, enum: OWNERSHIP, default: 'OWNED' },
  ownerName: { type: String, trim: true, maxlength: 80 }, ownerPhone: { type: String, trim: true, maxlength: 30 }, // lessor / hire company
  fuelType: { type: String, enum: ['PETROL', 'DIESEL', 'OTHER'], default: 'DIESEL' },
  odometerKm: { type: Number, min: 0, default: 0 },
  insuranceExpiry: Date, inspectionExpiry: Date, licenceExpiry: Date, nextServiceKm: Number, nextServiceDate: Date,
  defaultDriverId: { type: Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: VEHICLE_STATUS, default: 'AVAILABLE' },
  notes: { type: String, trim: true, maxlength: 300 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
schema.index({ businessId: 1, plate: 1 }, { unique: true });
module.exports = model('FleetVehicle', schema);
