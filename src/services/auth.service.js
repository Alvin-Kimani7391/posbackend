const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { mongoose } = require('../config/db');
const User = require('../models/User');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/tokens');

async function registerBusinessOwner({ businessName, ownerName, phone, email, password }) {
  const session = await mongoose.startSession();
  try {
    let business;
    let user;

    await session.withTransaction(async () => {
      const existing = await User.findOne({ phone }).session(session);
      if (existing) {
        throw ApiError.conflict('An account with this phone number already exists', 'PHONE_TAKEN');
      }

      business = (
        await Business.create([{ name: businessName, phone, email }], { session })
      )[0];

      const mainBranch = (
        await Branch.create(
          [{ businessId: business._id, name: 'Main Branch', code: 'MAIN', isMainBranch: true }],
          { session }
        )
      )[0];

      const passwordHash = await User.hashSecret(password);
      user = (
        await User.create(
          [
            {
              businessId: business._id,
              name: ownerName,
              phone,
              email,
              passwordHash,
              role: ROLES.OWNER,
              branchIds: [mainBranch._id],
              status: 'active',
            },
          ],
          { session }
        )
      )[0];

      await AuditLog.create(
        [{ businessId: business._id, userId: user._id, action: 'business.register', entityType: 'Business', entityId: business._id }],
        { session }
      );
    });

    return { business, user };
  } finally {
    session.endSession();
  }
}

async function issueTokens(user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  return { accessToken, refreshToken };
}

async function loginWithPassword({ identifier, password }, meta = {}) {
  const isEmail = identifier.includes('@');
  const query = isEmail ? { email: identifier.toLowerCase() } : { phone: identifier };

  const user = await User.findOne(query).select('+passwordHash');
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  const valid = await user.comparePassword(password);
  if (!valid) {
    throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  user.lastLoginAt = new Date();
  await user.save();

  await AuditLog.create({
    businessId: user.businessId,
    userId: user._id,
    action: 'login',
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });

  const tokens = await issueTokens(user);
  return { user, ...tokens };
}

async function loginWithPin({ businessId, employeeCode, pin }, meta = {}) {
  const user = await User.findOne({ businessId, employeeCode }).select('+pinHash');
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  const valid = await user.comparePin(pin);
  if (!valid) {
    throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  user.lastLoginAt = new Date();
  await user.save();

  await AuditLog.create({
    businessId: user.businessId,
    userId: user._id,
    action: 'login.pin',
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });

  const tokens = await issueTokens(user);
  return { user, ...tokens };
}

async function refreshTokens(refreshToken) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    throw ApiError.unauthorized('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }

  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('Account is inactive or no longer exists');
  }

  // If refreshTokenVersion has been bumped (e.g. logout-all / password change),
  // old refresh tokens are rejected even though they haven't expired yet.
  if (user.refreshTokenVersion !== payload.tokenVersion) {
    throw ApiError.unauthorized('Refresh token has been revoked', 'REFRESH_TOKEN_REVOKED');
  }

  return issueTokens(user);
}

async function logout(user) {
  user.refreshTokenVersion += 1; // invalidate all outstanding refresh tokens
  await user.save();
}

async function requestPasswordReset({ identifier }) {
  const isEmail = identifier.includes('@');
  const query = isEmail ? { email: identifier.toLowerCase() } : { phone: identifier };
  const user = await User.findOne(query);

  // Always respond as if successful to avoid leaking which accounts exist.
  if (!user) return null;

  const rawToken = crypto.randomBytes(32).toString('hex');
  user.passwordResetTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  user.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
  await user.save();

  // In production this raw token is delivered via SMS/email, never returned in the API response.
  return { user, rawToken };
}

async function resetPassword({ token, newPassword }) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select('+passwordResetTokenHash +passwordResetExpires');

  if (!user) {
    throw ApiError.badRequest('Invalid or expired reset token', 'INVALID_RESET_TOKEN');
  }

  user.passwordHash = await User.hashSecret(newPassword);
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpires = undefined;
  user.refreshTokenVersion += 1; // force re-login everywhere
  await user.save();
}

async function changePassword(user, { currentPassword, newPassword }) {
  const fullUser = await User.findById(user._id).select('+passwordHash');
  const valid = await fullUser.comparePassword(currentPassword);
  if (!valid) {
    throw ApiError.badRequest('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
  }
  fullUser.passwordHash = await User.hashSecret(newPassword);
  fullUser.refreshTokenVersion += 1;
  await fullUser.save();
}

module.exports = {
  registerBusinessOwner,
  loginWithPassword,
  loginWithPin,
  refreshTokens,
  logout,
  requestPasswordReset,
  resetPassword,
  changePassword,
};
