/**
 * The rider QR code: scan -> the rider web app opens for THIS business -> the rider signs in (phone + password, or employee code + PIN).
 * The QR carries only a signed token (d_<business>_<version>_<signature>); it is not a password. Anyone can scan it, but only a user
 * of this business whose role is DELIVERY_RIDER can sign in through it, and rotating the version kills every printed copy.
 * After sign-in the rider uses the normal access / refresh tokens and the normal /auth/refresh, so there is no second session system.
 */
const User = require('../../models/User');
const Branch = require('../../models/Branch');
const AuditLog = require('../../models/AuditLog');
const ApiError = require('../../utils/ApiError');
const { ROLES } = require('../../constants/roles');
const { loginPhoneCandidates } = require('../../utils/phone');
const { signAccessToken, signRefreshToken } = require('../../utils/tokens');
const authService = require('../auth.service');
const qr = require('../hospitality/qr.service');
const C = require('../restaurant/common');

const invalid = () => ApiError.notFound('This QR code is not valid any more. Please ask your manager for a new one.', 'QR_INVALID');
const baseUrl = (ctx) => {
  const fe = process.env.FRONTEND_URL && process.env.FRONTEND_URL !== '*' ? process.env.FRONTEND_URL.split(',')[0].trim() : '';
  return (process.env.RIDER_APP_URL || ctx.settings.guestOrdering?.baseUrl || process.env.GUEST_APP_URL || fe || '').replace(/\/+$/, '');
};
const riderPath = () => process.env.RIDER_APP_PATH || '/rider.html?t=';

/** Token -> the business, after checking the signature, the QR version and that the business may use riders. */
async function open(token) {
  const { kind, id, ver } = qr.parseToken(token);
  if (kind !== 'RIDER') throw invalid();
  let ctx; try { ctx = await C.getContext(id); } catch (e) { throw invalid(); }
  const rs = ctx.settings.rider || {};
  if ((rs.qrVersion || 1) !== ver) throw invalid();
  if (ctx.business.status && ctx.business.status !== 'active') throw ApiError.forbidden('This business is not active right now.', 'BUSINESS_INACTIVE');
  if (!ctx.features.ordering || rs.enabled === false) throw ApiError.forbidden('Rider deliveries are switched off for this business.', 'RIDERS_DISABLED');
  return { businessId: ctx.business._id, ctx, rider: rs };
}

/** What the rider login page shows before anyone signs in. */
async function publicContext(token) {
  const { businessId, ctx } = await open(token);
  const branches = await Branch.find({ businessId, status: 'active' }).select('name').sort({ name: 1 });
  return { business: { name: ctx.business.name, logo: ctx.business.logo, currency: ctx.business.currency || 'KES', timezone: ctx.timeZone }, branches: branches.map((b) => ({ id: b._id, name: b.name })), login: ['PHONE_PASSWORD', 'CODE_PIN'] };
}

async function finish(user, meta) {
  user.lastLoginAt = new Date(); await user.save();
  await AuditLog.create({ businessId: user.businessId, userId: user._id, action: 'login.rider_qr', ipAddress: meta.ip, userAgent: meta.userAgent });
  return { user, accessToken: signAccessToken(user), refreshToken: signRefreshToken(user) };
}

/** Sign in through the QR. body: { identifier, password } or { employeeCode, pin }. */
async function login(token, body, meta = {}) {
  const { businessId } = await open(token);
  const bad = () => ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  const notRider = () => ApiError.forbidden('This sign-in is for delivery riders. Staff sign in from the main app.', 'NOT_A_RIDER');
  if (body.employeeCode) {
    const u = await User.findOne({ businessId, employeeCode: body.employeeCode }).select('+pinHash');
    if (!u || u.status !== 'active') throw bad();
    if (u.role !== ROLES.DELIVERY_RIDER) { if (await u.comparePin(body.pin)) throw notRider(); throw bad(); }
    const out = await authService.loginWithPin({ businessId, employeeCode: body.employeeCode, pin: body.pin }, meta);
    return { user: out.user, accessToken: out.accessToken, refreshToken: out.refreshToken };
  }
  const isEmail = body.identifier.includes('@');
  const q = isEmail ? { businessId, email: body.identifier.toLowerCase() } : { businessId, phone: { $in: loginPhoneCandidates(body.identifier) } };
  const u = (await User.find(q).select('+passwordHash').limit(3)).find((x) => x.status === 'active');
  if (!u || !(await u.comparePassword(body.password))) throw bad();
  if (u.role !== ROLES.DELIVERY_RIDER) throw notRider();
  return finish(u, meta);
}

// ------------------------------------------------------------------ managers: print / rotate the rider QR
async function riderQr(businessId, user) {
  C.requireCan(user, 'restaurant.delivery.qr', 'Managing the rider QR code needs permission');
  const ctx = await C.getContext(businessId); const v = ctx.settings.rider?.qrVersion || 1; const t = qr.riderToken(businessId, v);
  const base = baseUrl(ctx);
  return { token: t, version: v, enabled: ctx.settings.rider?.enabled !== false, url: `${base}${riderPath()}${t}`, businessName: ctx.business.name };
}
async function rotateRiderQr(businessId, user) {
  C.requireCan(user, 'restaurant.delivery.qr', 'Managing the rider QR code needs permission');
  const { settings } = await C.getContext(businessId);
  // read-modify-write: settings saved before this feature have no stored rider.qrVersion, and $inc would restart it at 1 (the old QR would stay valid)
  settings.set('rider.qrVersion', (settings.rider?.qrVersion || 1) + 1); await settings.save();
  await C.audit({ businessId, userId: user._id, action: 'restaurant.rider_qr.rotate', entityType: 'RestaurantSettings', entityId: businessId });
  return riderQr(businessId, user);
}

module.exports = { open, publicContext, login, riderQr, rotateRiderQr };
