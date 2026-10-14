const { Schema, model } = require('mongoose');

/**
 * A customer's vehicle. One document per plate per business, so its job cards form a service history.
 * The latest odometer and the next service due are updated when a job card is collected.
 */
const vehicleSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    ownerName: { type: String, trim: true },   // snapshot, so the vehicle is usable without a customer record
    ownerPhone: { type: String, trim: true },

    plate: { type: String, required: true },    // normalized (see utils/vehicle.js)
    plateDisplay: { type: String, trim: true }, // as typed, e.g. "KDG 123A"
    vin: { type: String },                      // normalized 17-char VIN, optional
    make: { type: String, trim: true, required: true },
    model: { type: String, trim: true },
    year: { type: Number, min: 1950, max: 2100 },
    color: { type: String, trim: true },
    engineNo: { type: String, trim: true },
    fuelType: { type: String, enum: ['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'OTHER'], default: 'PETROL' },
    transmission: { type: String, enum: ['MANUAL', 'AUTOMATIC', 'OTHER'] },

    odometerKm: { type: Number, min: 0, default: 0 }, // last known reading
    lastServiceAt: { type: Date },
    lastServiceKm: { type: Number },
    nextServiceKm: { type: Number },
    nextServiceDate: { type: Date },
    insuranceExpiry: { type: Date },
    notes: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

vehicleSchema.index({ businessId: 1, plate: 1 }, { unique: true });
vehicleSchema.index({ businessId: 1, vin: 1 }, { unique: true, partialFilterExpression: { vin: { $type: 'string' } } });
vehicleSchema.index({ businessId: 1, customerId: 1 });
vehicleSchema.index({ businessId: 1, nextServiceDate: 1 });

module.exports = model('Vehicle', vehicleSchema);