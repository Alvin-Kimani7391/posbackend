const { Schema, model } = require('mongoose');
const { HK_TASK_TYPES, HK_TASK_STATUS } = require('../constants/hospitality');

const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: String,
  type: { type: String, enum: HK_TASK_TYPES, required: true },
  status: { type: String, enum: HK_TASK_STATUS, default: 'PENDING' },
  priority: { type: String, enum: ['NORMAL', 'URGENT'], default: 'NORMAL' },
  stayId: Schema.Types.ObjectId,
  note: { type: String, trim: true, maxlength: 500 },
  assignedTo: Schema.Types.ObjectId, assignedName: String,
  auto: { type: Boolean, default: false },
  dueAt: Date, startedAt: Date, completedAt: Date, completedBy: Schema.Types.ObjectId,
  createdBy: Schema.Types.ObjectId,
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, status: 1, createdAt: -1 });
s.index({ businessId: 1, roomId: 1, status: 1 });
s.index({ businessId: 1, assignedTo: 1, status: 1 });
module.exports = model('HousekeepingTask', s);
