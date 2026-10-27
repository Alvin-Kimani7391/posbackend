const { Schema, model } = require('mongoose');
const { MOVEMENT_TYPES } = require('../constants/liquor');
const containerMovementSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
  containerTypeId: { type: Schema.Types.ObjectId, ref: 'ContainerType', required: true, index: true },
  type: { type: String, enum: MOVEMENT_TYPES, required: true },
  quantity: { type: Number, required: true }, // always positive; the type gives the direction
  reverses: { type: String, enum: MOVEMENT_TYPES }, // for REVERSAL: which type this undoes
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', index: true },
  supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
  saleId: { type: Schema.Types.ObjectId, ref: 'Sale', index: true },
  amount: { type: Number }, // integer cents (deposit refunded)
  note: { type: String, trim: true, maxlength: 200 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
containerMovementSchema.index({ businessId: 1, containerTypeId: 1, createdAt: -1 });
module.exports = model('ContainerMovement', containerMovementSchema);
