const { Schema, model } = require('mongoose');
const C = require('../constants/restaurant');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  type: { type: String, enum: C.INCIDENT_TYPES, required: true },
  orderId: Schema.Types.ObjectId, orderNumber: String, tableName: String, orderItemId: Schema.Types.ObjectId,
  description: { type: String, required: true, trim: true },
  severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
  status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' },
  resolution: String, compensation: String,
  raisedBy: Schema.Types.ObjectId, resolvedBy: Schema.Types.ObjectId, resolvedAt: Date,
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, status: 1, createdAt: -1 });
module.exports = model('ServiceIncident', s);
