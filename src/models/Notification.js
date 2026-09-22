const { Schema, model } = require('mongoose');

const NOTIFICATION_TYPES = [
  'LOW_STOCK', 'OUT_OF_STOCK', 'PAYMENT_FAILED', 'REFUND_REQUEST',
  'CASH_SHORTAGE', 'ETIMS_FAILED', 'CREDIT_DUE', 'SYSTEM_ALERT',
];

const notificationSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    data: { type: Schema.Types.Mixed },

    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ businessId: 1, userId: 1, readAt: 1, createdAt: -1 });

const Notification = model('Notification', notificationSchema);
module.exports = Notification;
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;