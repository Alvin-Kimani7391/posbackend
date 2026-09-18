const { Schema, model } = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES } = require('../constants/roles');

const userSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },

    passwordHash: { type: String, required: true, select: false },
    pinHash: { type: String, select: false },

    role: { type: String, enum: Object.values(ROLES), required: true },
    // Extra permissions granted on top of the role's defaults, and permissions
    // explicitly revoked from the role's defaults.
    grantedPermissions: [{ type: String }],
    revokedPermissions: [{ type: String }],

    employeeCode: { type: String, trim: true },
    branchIds: [{ type: Schema.Types.ObjectId, ref: 'Branch' }],

    status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
    lastLoginAt: { type: Date },

    refreshTokenVersion: { type: Number, default: 0 }, // bump to invalidate all refresh tokens

    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

userSchema.index({ businessId: 1, email: 1 }, { unique: true, sparse: true });
userSchema.index({ businessId: 1, phone: 1 }, { unique: true });
userSchema.index({ businessId: 1, employeeCode: 1 }, { unique: true, sparse: true });

userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.comparePin = function comparePin(plain) {
  if (!this.pinHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.pinHash);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.pinHash;
  delete obj.refreshTokenVersion;
  return obj;
};

userSchema.statics.hashSecret = function hashSecret(plain) {
  return bcrypt.hash(plain, 12);
};

module.exports = model('User', userSchema);
