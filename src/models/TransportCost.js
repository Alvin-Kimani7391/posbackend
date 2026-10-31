const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { COST_TYPES } = require('../constants/hardware');
/** A transport cost. With deliveryId it is a DIRECT JOB COST; without it, a vehicle overhead (service, insurance...). 
 *  expenseId links a cost to an Expense that was already recorded: the linked amount is carved out of operating expenses, so it is counted once. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
  deliveryId: { type: Schema.Types.ObjectId, ref: 'DeliveryOrder' },
  fleetVehicleId: { type: Schema.Types.ObjectId, ref: 'FleetVehicle' },
  type: { type: String, enum: COST_TYPES, required: true },
  amount: { type: Number, required: true, min: 1 },
  date: { type: Date, default: Date.now },
  payee: { type: String, trim: true, maxlength: 80 }, payeeUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  paid: { type: Boolean, default: true }, paidAt: Date, paymentMethod: { type: String, enum: ['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER'] }, reference: { type: String, trim: true, maxlength: 60 },
  litres: { type: Number, min: 0 }, odometerKm: { type: Number, min: 0 }, downtimeDays: { type: Number, min: 0 },
  expenseId: { type: Schema.Types.ObjectId, ref: 'Expense' },
  note: { type: String, trim: true, maxlength: 200 },
  voided: { type: Boolean, default: false }, voidReason: String, voidedBy: { type: Schema.Types.ObjectId, ref: 'User' }, voidedAt: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, deliveryId: 1 });
schema.index({ businessId: 1, fleetVehicleId: 1, date: -1 });
schema.index({ businessId: 1, expenseId: 1 });
moneyFields(schema, ['amount']);
module.exports = model('TransportCost', schema);
