const { Schema, model } = require('mongoose');
/** Staff duty / roster record: who is scheduled, who is on the floor right now, attendance. Cash drawers stay on CashShift. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  scheduledStart: Date, scheduledEnd: Date,
  clockIn: Date, clockOut: Date,
  status: { type: String, enum: ['SCHEDULED', 'ON_DUTY', 'BREAK', 'UNAVAILABLE', 'COMPLETED', 'ABSENT'], default: 'SCHEDULED' },
  acceptingTables: { type: Boolean, default: true },   // false = on duty but no new tables
  cashShiftId: { type: Schema.Types.ObjectId, ref: 'CashShift' },
  notes: String, createdBy: Schema.Types.ObjectId,
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, status: 1 });
s.index({ businessId: 1, userId: 1, status: 1 });
s.index({ businessId: 1, branchId: 1, scheduledStart: 1 });
module.exports = model('RestaurantShift', s);
