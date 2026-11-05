const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { mongoose } = require('../config/db');
const User = require('../models/User');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const billing = require('./billing.service');
const { resolveFeatures } = require('../constants/businessFeatures');
const countryService = require('./country.service');
const { phoneForStorage, loginPhoneCandidates } = require('../utils/phone');
const { invalidateBusinessContext } = require('../utils/businessContext');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/tokens');

async function registerBusinessOwner({ businessName, businessType = 'general_shop', country = 'KE', language, ownerName, phone: rawPhone, email, password }) {
  // Tanzanian numbers are stored internationally (255...), so a Tanzanian 0712... can never collide with a Kenyan 0712...
  const defaults = countryService.buildBusinessDefaults(country, language);
  const phone = phoneForStorage(rawPhone, defaults.countryCode);
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
        await Business.create(
          [{ ...defaults, countryConfirmed: true, name: businessName, businessType, featureSettings: resolveFeatures(businessType), phone, email }],
          { session }
        )
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

    // Start billing after the business and owner have been created.
    await billing.startSubscription(business._id)
      .catch((e) => console.error('[billing] start failed', e.message));

    invalidateBusinessContext(business._id);
    require('./authMail.service').sendOwnerWelcome({ user, business }).catch((e) => console.error('[mail] owner welcome failed', e.message));
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

/**
 * Blocks login/refresh for every user of a suspended or closed business.
 * (authenticate() enforces the same rule on every request, so a suspension
 * takes effect immediately, not only at the next login.)
 * Platform admins belong to no business and are exempt.
 */
async function assertBusinessActive(user) {
  if (user.role === ROLES.SUPER_ADMIN) return;
  const biz = await Business.findById(user.businessId).select('status').lean();
  if (!biz || biz.status !== 'active') {
    throw ApiError.forbidden('This business account is suspended. Contact support.', 'BUSINESS_SUSPENDED');
  }
}

async function loginWithPassword({ identifier, password }, meta = {}) {
  const isEmail = identifier.includes('@');
  // A phone may be stored as typed (Kenya) or as 255XXXXXXXXX (Tanzania). The same local number can exist in both
  // countries, so the password is checked against every active match, never just the first.
  const query = isEmail ? { email: identifier.toLowerCase() } : { phone: { $in: loginPhoneCandidates(identifier) } };

  const candidates = (await User.find(query).select('+passwordHash').limit(5)).filter((u) => u.status === 'active');
  let user = null;
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await c.comparePassword(password)) { user = c; break; }
  }
  if (!user) {
    throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  await assertBusinessActive(user);

  user.lastLoginAt = new Date();
  await user.save();

  // AuditLog.businessId is required; a platform admin has none, so skip it.
  if (user.businessId) {
    await AuditLog.create({
      businessId: user.businessId,
      userId: user._id,
      action: 'login',
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  }

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

  await assertBusinessActive(user);

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

  await assertBusinessActive(user);

  return issueTokens(user);
}

async function logout(user) {
  user.refreshTokenVersion += 1; // invalidate all outstanding refresh tokens
  await user.save();
}

/**
 * Emails a reset link. kind = 'password' (owners, managers, anyone) or 'pin' (employees who sign in with a PIN).
 * The link is only ever emailed to the address on file, and the answer is always the same so nobody can probe which
 * accounts exist.
 */
async function requestPasswordReset({ identifier, kind = 'password' }) {
  const mail = require('./authMail.service');
  const isEmail = identifier.includes('@');
  const query = isEmail ? { email: identifier.toLowerCase() } : { phone: { $in: loginPhoneCandidates(identifier) } };
  if (kind === 'pin') query.employeeCode = { $type: 'string' };
  const users = await User.find({ ...query, status: 'active' }).limit(5);

  let firstHit = null;
  for (const user of users) {
    if (!user.email) continue; // nowhere to send it; the person must ask their manager
    const rawToken = await mail.issueResetToken(user._id, 30);
    if (!firstHit) firstHit = { user, rawToken };
    const business = await Business.findById(user.businessId).select('name').lean().catch(() => null);
    await mail.sendResetEmail({ user, rawToken, kind, businessName: business && business.name });
  }
  return firstHit;
}

/** Sets a new password (newPassword) or a new employee PIN (newPin) with a valid emailed token. */
async function resetPassword({ token, newPassword, newPin }) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select('+passwordHash +pinHash +passwordResetTokenHash +passwordResetExpires');

  if (!user) {
    throw ApiError.badRequest('Invalid or expired reset token', 'INVALID_RESET_TOKEN');
  }

  if (newPin) {
    if (!user.employeeCode) throw ApiError.badRequest('This account does not use a PIN', 'NO_PIN_ACCOUNT');
    user.pinHash = await User.hashSecret(newPin);
  } else {
    user.passwordHash = await User.hashSecret(newPassword);
  }
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpires = undefined;
  user.refreshTokenVersion += 1; // force re-login everywhere
  await user.save();
}

async function setLanguage(user, language) {
  user.language = language;
  await user.save();
  return user;
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
  setLanguage,
};