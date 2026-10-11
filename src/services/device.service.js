'use strict';
const crypto = require('crypto');
const Device = require('../models/Device');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const { nextSequence, pad } = require('../models/Counter');
const { POLICY_KEYS, getPolicy, effectiveOfflineHours } = require('../utils/offlinePolicy');
const { signOfflineGrant } = require('../utils/offlineGrant');
const { maxDiscountPercentForRole } = require('./sale-pricing.util');
const { userHasPermission } = require('../middleware/auth');

/* ---------- helpers ---------- */

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();

function secretMatches(provided, storedHex) {
  if (!provided || !storedHex) return false;
  const a = sha256(provided);
  const b = Buffer.from(storedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicDevice(doc) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  delete o.secretHash;
  return o;
}

function assertOwner(user) {
  if (!user || user.role !== ROLES.OWNER) {
    throw ApiError.forbidden('Only the business owner can change offline settings', 'OWNER_ONLY');
  }
}

function userCanUseBranch(user, branchId) {
  if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN) return true;
  return (user.branchIds || []).some((id) => String(id) === String(branchId));
}

/**
 * Proves a request really comes from an enrolled device (deviceId + secret header).
 * Exported because the sync endpoints (next phase) reuse it.
 * Revoked devices get DEVICE_REVOKED so the sync engine can HOLD their sales instead of discarding them.
 */
async function authenticateDevice(businessId, deviceId, secret) {
  const device = await Device.findOne({ businessId, deviceId }).select('+secretHash');
  if (!device) throw ApiError.forbidden('This device is not enrolled', 'DEVICE_UNKNOWN');
  if (!secretMatches(secret, device.secretHash)) throw ApiError.forbidden('Device credentials are invalid', 'DEVICE_SECRET_INVALID');
  if (device.status !== 'active') throw ApiError.forbidden('This device has been blocked by the business', 'DEVICE_REVOKED');
  return device;
}

/** Like authenticateDevice but ALSO returns revoked devices (sync must HOLD their sales, never discard them). */
async function loadDeviceWithSecret(businessId, deviceId, secret) {
  const device = await Device.findOne({ businessId, deviceId }).select('+secretHash');
  if (!device) throw ApiError.forbidden('This device is not enrolled', 'DEVICE_UNKNOWN');
  if (!secretMatches(secret, device.secretHash)) throw ApiError.forbidden('Device credentials are invalid', 'DEVICE_SECRET_INVALID');
  return device;
}

/* ---------- enrollment & management (manager/owner, online) ---------- */

async function enrollDevice(businessId, user, input) {
  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');
  const policy = getPolicy(business);

  const branch = await Branch.findOne({ _id: input.branchId, businessId });
  if (!branch) throw ApiError.badRequest('Branch not found', 'INVALID_BRANCH');

  if (input.offlineEnabled && !policy.enabled) {
    throw ApiError.badRequest('Turn on offline mode in the business offline settings first', 'OFFLINE_DISABLED');
  }

  const existing = await Device.findOne({ businessId, deviceId: input.deviceId });
  if (existing) throw ApiError.conflict('This device is already enrolled', 'DEVICE_ALREADY_ENROLLED');

  const seq = await nextSequence(businessId, 'device:business');
  const deviceCode = `T${pad(seq, 2)}`;
  const secret = crypto.randomBytes(32).toString('hex'); // returned ONCE, only its hash is stored

  const device = await Device.create({
    businessId,
    branchId: branch._id,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    deviceType: input.deviceType || 'WEB',
    deviceCode,
    mode: input.mode || policy.defaultDeviceMode,
    offlineEnabled: !!input.offlineEnabled,
    secretHash: sha256(secret).toString('hex'),
    registeredBy: user._id,
    enrolledAt: new Date(),
  });

  await AuditLog.create({
    businessId, branchId: branch._id, userId: user._id, action: 'device.enroll',
    entityType: 'Device', entityId: device._id,
    newValue: { deviceCode, mode: device.mode, offlineEnabled: device.offlineEnabled, deviceName: device.deviceName },
  });

  return { device: publicDevice(device), deviceSecret: secret };
}

async function listDevices(businessId, { branchId } = {}) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  const items = await Device.find(filter).populate('branchId', 'name code').sort({ createdAt: -1 });
  return { items: items.map(publicDevice) };
}

async function updateDevice(businessId, user, id, patch) {
  const business = await Business.findById(businessId);
  const policy = getPolicy(business);
  if (patch.offlineEnabled === true && !policy.enabled) {
    throw ApiError.badRequest('Turn on offline mode in the business offline settings first', 'OFFLINE_DISABLED');
  }

  const $set = {};
  const $unset = {};
  ['deviceName', 'mode', 'offlineEnabled'].forEach((k) => { if (patch[k] !== undefined) $set[k] = patch[k]; });
  if (patch.maxOfflineHoursOverride !== undefined) {
    if (patch.maxOfflineHoursOverride === null) $unset.maxOfflineHoursOverride = 1;
    else $set.maxOfflineHoursOverride = patch.maxOfflineHoursOverride;
  }
  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;

  const device = await Device.findOneAndUpdate({ _id: id, businessId }, update, { new: true });
  if (!device) throw ApiError.notFound('Device not found');

  await AuditLog.create({
    businessId, branchId: device.branchId, userId: user._id, action: 'device.update',
    entityType: 'Device', entityId: device._id, newValue: patch,
  });
  return publicDevice(device);
}

async function revokeDevice(businessId, user, id, reason) {
  const device = await Device.findOneAndUpdate(
    { _id: id, businessId, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: user._id, revokeReason: reason, offlineEnabled: false } },
    { new: true }
  );
  if (!device) {
    const exists = await Device.exists({ _id: id, businessId });
    if (!exists) throw ApiError.notFound('Device not found');
    throw ApiError.conflict('This device is already blocked', 'DEVICE_ALREADY_REVOKED');
  }
  await AuditLog.create({
    businessId, branchId: device.branchId, userId: user._id, action: 'device.revoke',
    entityType: 'Device', entityId: device._id, newValue: { reason },
  });
  return publicDevice(device);
}

/* ---------- grant & heartbeat (cashier on an enrolled device, online) ---------- */

async function issueGrant(businessId, user, deviceId, secret) {
  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');

  const policy = getPolicy(business);
  if (!policy.enabled) throw ApiError.forbidden('Offline selling is not enabled for this business', 'OFFLINE_DISABLED');

  const device = await authenticateDevice(businessId, deviceId, secret);
  if (!device.offlineEnabled) throw ApiError.forbidden('Offline selling is not enabled for this device', 'OFFLINE_NOT_ENABLED_FOR_DEVICE');
  if (!userCanUseBranch(user, device.branchId)) throw ApiError.forbidden('You do not have access to this device’s branch', 'BRANCH_ACCESS_DENIED');

  const hours = effectiveOfflineHours(policy, device);
  const branch = await Branch.findById(device.branchId).select('code name');
  const now = Date.now();
  const offlineUntil = now + hours * 3600 * 1000;

  // Offline discount = the stricter of the role limit and the business offline limit (owners included).
  const maxDiscountPercent = Math.min(maxDiscountPercentForRole(user.role, business), policy.maxDiscountPercent);

  const caps = {
    maxDiscountPercent,
    canOverridePrice: false, // price override is never allowed offline in this release
    canOpenShift: !!userHasPermission(user, 'shifts.open'),
    canCloseShift: !!userHasPermission(user, 'shifts.close'),
    allowCredit: policy.allowCredit,
    allowManualMpesa: policy.allowManualMpesa,
    allowCard: policy.allowCard,
    allowRefunds: policy.allowRefunds,
  };
  const limits = {
    maxPendingSales: policy.maxPendingSales,
    maxPendingValueCents: policy.maxPendingValueCents,
    sessionHours: policy.sessionHours,
    maxManualMpesaCents: policy.maxManualMpesaCents,
    manualMpesaApproval: policy.manualMpesaApproval,
    allowShiftCloseWithPending: policy.allowShiftCloseWithPending,
  };

  const grant = signOfflineGrant(
    {
      sub: String(user._id),
      businessId: String(businessId),
      branchId: String(device.branchId),
      deviceId: device.deviceId,
      deviceCode: device.deviceCode,
      deviceMode: device.mode,
      receiptPrefix: (business.receiptSettings && business.receiptSettings.receiptPrefix) || 'RCT',
      branchCode: (branch && branch.code) || 'MAIN',
      role: user.role,
      userName: user.name,
      issuedAtMs: now,
      offlineUntil,
      caps,
      limits,
    },
    hours * 3600
  );

  await Device.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date() } });
  await AuditLog.create({
    businessId, branchId: device.branchId, userId: user._id, action: 'offline.grant.issue',
    entityType: 'Device', entityId: device._id, newValue: { deviceCode: device.deviceCode, hours, caps },
  });

  return {
    grant,
    offlineUntil: new Date(offlineUntil).toISOString(),
    serverTime: new Date(now).toISOString(),
    deviceCode: device.deviceCode,
    mode: device.mode,
    caps,
    limits,
  };
}

async function heartbeat(businessId, deviceId, secret, { appVersion, pendingCount } = {}) {
  const device = await authenticateDevice(businessId, deviceId, secret);
  const $set = { lastSeenAt: new Date() };
  if (appVersion) $set.appVersion = appVersion;
  if (pendingCount !== undefined) $set.lastPendingCount = pendingCount;
  await Device.updateOne({ _id: device._id }, { $set });
  return { status: device.status, serverTime: new Date().toISOString() };
}

/* ---------- business offline policy ---------- */

async function getOfflinePolicy(businessId) {
  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');
  return getPolicy(business);
}

async function updateOfflinePolicy(businessId, user, patch) {
  assertOwner(user);
  const $set = {};
  for (const key of POLICY_KEYS) {
    if (patch[key] !== undefined) $set[`settings.offline.${key}`] = patch[key];
  }
  if (!Object.keys($set).length) throw ApiError.badRequest('Nothing to update', 'NO_CHANGES');

  const business = await Business.findByIdAndUpdate(businessId, { $set }, { new: true, runValidators: true });
  if (!business) throw ApiError.notFound('Business not found');

  await AuditLog.create({
    businessId, userId: user._id, action: 'settings.offline.update',
    entityType: 'Business', entityId: business._id, newValue: patch,
  });
  return getPolicy(business);
}

/* ---------- offline PIN (each user sets their own, online) ---------- */

/**
 * `password` is the proof of identity. It may be EITHER the user's account password (owner, admin, manager,
 * accountant...) OR the user's everyday login PIN (cashiers who sign in with Business ID + employee code + PIN
 * and may never have used a password).
 * `pin` is the NEW offline PIN (6-8 digits, validated in the route). It is stored only as a PBKDF2 verifier.
 */
async function setOfflinePin(businessId, user, { password, pin }) {
  const u = await User.findOne({ _id: user._id, businessId }).select('+passwordHash +pinHash');
  if (!u) throw ApiError.unauthorized('Account not found', 'WRONG_PASSWORD');

  const byPassword = await u.comparePassword(String(password)).catch(() => false);
  const byLoginPin = byPassword ? false : await u.comparePin(String(password)).catch(() => false);
  if (!byPassword && !byLoginPin) {
    throw ApiError.unauthorized('Your login PIN or password is incorrect', 'WRONG_PASSWORD');
  }

  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto.pbkdf2Sync(pin, Buffer.from(salt, 'base64'), 210000, 32, 'sha256').toString('base64');
  await User.updateOne({ _id: u._id }, { $set: { offlinePin: { salt, iterations: 210000, hash, setAt: new Date() } } });
  await AuditLog.create({
    businessId, userId: u._id, action: 'offline.pin.set', entityType: 'User', entityId: u._id,
    newValue: { verifiedWith: byPassword ? 'password' : 'login_pin' },
  });
  return { ok: true };
}

/** Manager, online, on the till: one signed grant + PIN verifier per cashier of the branch (shared tills). */
async function issueRoster(businessId, manager, deviceId, secret) {
  const [business, device] = await Promise.all([Business.findById(businessId), authenticateDevice(businessId, deviceId, secret)]);
  const policy = getPolicy(business);
  if (!policy.enabled || !device.offlineEnabled) throw ApiError.forbidden('Offline selling is not enabled for this till', 'OFFLINE_NOT_ENABLED_FOR_DEVICE');
  const branch = await Branch.findById(device.branchId).select('code');
  const hours = effectiveOfflineHours(policy, device);
  const now = Date.now();
  const users = await User.find({
    businessId, status: 'active', 'offlinePin.hash': { $exists: true },
    $or: [{ branchIds: device.branchId }, { role: { $in: [ROLES.OWNER, ROLES.ADMIN] } }],
  }).select('+offlinePin name role employeeCode branchIds grantedPermissions revokedPermissions');

  const roster = users.map((u) => {
    const caps = {
      maxDiscountPercent: Math.min(maxDiscountPercentForRole(u.role, business), policy.maxDiscountPercent), canOverridePrice: false,
      canOpenShift: !!userHasPermission(u, 'shifts.open'), canCloseShift: !!userHasPermission(u, 'shifts.close'),
      allowCredit: policy.allowCredit, allowManualMpesa: policy.allowManualMpesa, allowCard: policy.allowCard, allowRefunds: policy.allowRefunds,
    };
    const limits = { maxPendingSales: policy.maxPendingSales, maxPendingValueCents: policy.maxPendingValueCents, sessionHours: policy.sessionHours,
      maxManualMpesaCents: policy.maxManualMpesaCents, manualMpesaApproval: policy.manualMpesaApproval, allowShiftCloseWithPending: policy.allowShiftCloseWithPending };
    const grant = signOfflineGrant({
      sub: String(u._id), businessId: String(businessId), branchId: String(device.branchId), deviceId: device.deviceId, deviceCode: device.deviceCode,
      deviceMode: device.mode, receiptPrefix: (business.receiptSettings && business.receiptSettings.receiptPrefix) || 'RCT',
      branchCode: (branch && branch.code) || 'MAIN', role: u.role, userName: u.name, issuedAtMs: now, offlineUntil: now + hours * 3600e3, caps, limits,
    }, hours * 3600);
    return { userId: String(u._id), name: u.name, role: u.role, employeeCode: u.employeeCode, grant, caps,
      pin: { salt: u.offlinePin.salt, iterations: u.offlinePin.iterations, hash: u.offlinePin.hash } };
  });
  await AuditLog.create({ businessId, branchId: device.branchId, userId: manager._id, action: 'offline.roster.issue', entityType: 'Device', entityId: device._id, newValue: { count: roster.length } });
  return { roster, serverTime: new Date(now).toISOString() };
}

module.exports = {
  authenticateDevice, loadDeviceWithSecret, userCanUseBranch,
  enrollDevice, listDevices, updateDevice, revokeDevice,
  issueGrant, heartbeat,
  getOfflinePolicy, updateOfflinePolicy,
  setOfflinePin, issueRoster,
};