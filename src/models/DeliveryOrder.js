const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { DELIVERY_STATUSES, PROOF_TYPES, JOB_KINDS } = require('../constants/hardware');
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  number: { type: String, required: true },
  status: { type: String, enum: DELIVERY_STATUSES, default: 'PENDING' },
  saleId: { type: Schema.Types.ObjectId, ref: 'Sale' }, quotationId: { type: Schema.Types.ObjectId, ref: 'Quotation' }, projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  contactName: { type: String, trim: true, maxlength: 80 }, contactPhone: { type: String, trim: true, maxlength: 30 },
  address: { type: String, required: true, trim: true, maxlength: 250 },
  scheduledFor: { type: Date, required: true }, window: { type: String, trim: true, maxlength: 40 },
  vehicle: { type: String, trim: true, maxlength: 30 },            // plate / truck name
  driverId: { type: Schema.Types.ObjectId, ref: 'User' },
  items: [{ _id: false, productId: Schema.Types.ObjectId, variantId: Schema.Types.ObjectId, name: String, unitName: String, quantity: Number, deliveredQuantity: { type: Number, default: 0 }, handling: [String] }],
  kind: { type: String, enum: JOB_KINDS, default: 'DELIVERY' },   // TRANSPORT_ONLY = a haulage booking with no shop goods
  collectionPoint: { type: String, trim: true, maxlength: 250 }, zone: { type: String, trim: true, lowercase: true, maxlength: 60 },
  distanceKm: { type: Number, min: 0 }, loadWeightKg: { type: Number, min: 0 }, loadVolumeM3: { type: Number, min: 0 }, loadNote: { type: String, trim: true, maxlength: 200 },
  fleetVehicleId: { type: Schema.Types.ObjectId, ref: 'FleetVehicle' },
  loaders: [{ _id: false, name: { type: String, trim: true, maxlength: 60 }, userId: Schema.Types.ObjectId }],
  subcontractor: { name: { type: String, trim: true, maxlength: 80 }, phone: { type: String, trim: true, maxlength: 30 }, plate: { type: String, trim: true, maxlength: 20 } },
  pricing: { lines: [{ _id: false, component: String, rateId: Schema.Types.ObjectId, name: String, basis: String, quantity: Number, unitValue: Number, amount: Number, note: String }], subtotal: Number, negotiated: Boolean, waivedFree: Boolean, absorbed: Boolean },
  payments: [{ _id: false, kind: { type: String, enum: ['DEPOSIT', 'PAYMENT', 'REFUND'], default: 'PAYMENT' }, amount: Number, method: String, reference: String, at: Date, by: Schema.Types.ObjectId }],
  paidTotal: { type: Number, default: 0 }, paymentStatus: { type: String, enum: ['NO_CHARGE', 'UNPAID', 'PART', 'PAID'], default: 'NO_CHARGE' },
  loadedAt: Date, dispatchedAt: Date, arrivedAt: Date, returnedAt: Date, odometerStart: Number, odometerEnd: Number, kmTravelled: Number, returnTrip: { type: Boolean, default: false },
  charge: { type: Number, default: 0 },                            // what the customer pays for delivery
  cost: { type: Number, default: 0 },                              // what it cost us (fuel, driver, hire)
  proof: { type: { type: String, enum: PROOF_TYPES }, receivedBy: String, signatureUrl: String, photoUrl: String, at: Date, by: Schema.Types.ObjectId },
  otpHash: { type: String, select: false }, otpExpiresAt: { type: Date, select: false }, otpTries: { type: Number, default: 0, select: false },
  failedReason: { type: String, trim: true, maxlength: 200 },
  attempts: { type: Number, default: 0 },
  notes: { type: String, trim: true, maxlength: 300 },
  events: [{ _id: false, status: String, at: Date, by: Schema.Types.ObjectId, note: String }],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, number: 1 }, { unique: true });
schema.index({ businessId: 1, status: 1, scheduledFor: 1 });
schema.index({ businessId: 1, driverId: 1, status: 1 });
schema.index({ businessId: 1, fleetVehicleId: 1, scheduledFor: 1 });
schema.index({ businessId: 1, 'payments.reference': 1 }, { unique: true, partialFilterExpression: { 'payments.reference': { $type: 'string' } } }); // one provider reference cannot pay two jobs
moneyFields(schema, ['charge', 'cost', 'paidTotal'], { payments: ['amount'] });
module.exports = model('DeliveryOrder', schema);
