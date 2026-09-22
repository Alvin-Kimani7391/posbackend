const { Schema, model } = require('mongoose');

const deviceSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    deviceId: { type: String, required: true, trim: true }, // client-generated stable identifier
    deviceName: { type: String, trim: true },
    deviceType: { type: String, enum: ['POS', 'TABLET', 'PHONE', 'WEB', 'OTHER'], default: 'WEB' },

    lastSyncAt: { type: Date },
    appVersion: { type: String },

    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    registeredBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

deviceSchema.index({ businessId: 1, deviceId: 1 }, { unique: true });

module.exports = model('Device', deviceSchema);