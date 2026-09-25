const { Schema, model } = require('mongoose');
const { NOTIFICATION_TYPES } = require('../constants/notificationTypes');

const notificationSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // recipient

    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    title: { type: String, required: true },
    message: { type: String, required: true },
    data: { type: Schema.Types.Mixed }, // event payload, e.g. { shiftId, cashDifference, sales: [...] }

    sourceUserId: { type: Schema.Types.ObjectId, ref: 'User' }, // who/what triggered it (not the recipient)
    entityType: { type: String }, // 'CashShift' | 'Sale' | 'BranchInventory' | 'StockTransfer' | ...
    entityId: { type: Schema.Types.ObjectId },

    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ businessId: 1, userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ businessId: 1, type: 1, createdAt: -1 });

const Notification = model('Notification', notificationSchema);
module.exports = Notification;
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;