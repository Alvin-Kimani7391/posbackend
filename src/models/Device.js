const { Schema, model } = require('mongoose');

const deviceSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    deviceId: { type: String, required: true, trim: true }, // client-generated stable identifier (UUID kept in IndexedDB)
    deviceName: { type: String, trim: true },
    deviceType: { type: String, enum: ['POS', 'TABLET', 'PHONE', 'WEB', 'OTHER'], default: 'WEB' },

    // --- offline additions ---
    deviceCode: { type: String, trim: true, uppercase: true }, // short code used in receipt numbers, e.g. "T03"
    mode: { type: String, enum: ['DEDICATED', 'SHARED'], default: 'DEDICATED' },
    offlineEnabled: { type: Boolean, default: false },
    maxOfflineHoursOverride: { type: Number, min: 1, max: 72 }, // can only make the business policy stricter
    secretHash: { type: String, select: false },                // sha256 of the device secret; the secret itself is shown once at enrollment

    lastSyncAt: { type: Date },
    lastSeenAt: { type: Date },
    lastPendingCount: { type: Number },
    highestLocalSeq: { type: Number, default: 0 },              // highest local receipt sequence the server has seen (gap detection)
    appVersion: { type: String },

    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    registeredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    enrolledAt: { type: Date },
    revokedAt: { type: Date },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokeReason: { type: String },
  },
  { timestamps: true }
);

deviceSchema.index({ businessId: 1, deviceId: 1 }, { unique: true });
// Partial so devices enrolled before this change (no deviceCode) never collide.
deviceSchema.index(
  { businessId: 1, deviceCode: 1 },
  { unique: true, partialFilterExpression: { deviceCode: { $type: 'string' } } }
);

module.exports = model('Device', deviceSchema);