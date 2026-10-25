const { Schema, model } = require('mongoose');
/** A cashier counted a rider's cash. `variance` = received - expected (negative = the rider is short). Amounts are integer cents. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  riderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  riderName: String,
  cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  cashierName: String,
  shiftId: Schema.Types.ObjectId,
  collectionIds: [Schema.Types.ObjectId],
  orderNumbers: [String],
  expected: { type: Number, required: true },
  received: { type: Number, required: true },
  variance: { type: Number, default: 0 },
  note: String,
}, { timestamps: true });
s.index({ businessId: 1, riderId: 1, createdAt: -1 });
s.index({ businessId: 1, branchId: 1, createdAt: -1 });
module.exports = model('RiderHandover', s);
