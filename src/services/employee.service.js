const crypto = require('crypto');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const { getBusinessContext } = require('../utils/businessContext');
const { isValidPhone, phoneForStorage } = require('../utils/phone');

/** Validate a phone against the business's country and return the form we store. */
async function resolvePhone(businessId, phone) {
  const ctx = await getBusinessContext(businessId);
  if (!isValidPhone(phone, ctx.countryCode)) {
    throw ApiError.badRequest(`Enter a valid ${ctx.country.name} phone number`, 'INVALID_PHONE');
  }
  return phoneForStorage(phone, ctx.countryCode);
}

// Roles that can never be assigned through the employee API.
const RESERVED_ROLES = [ROLES.OWNER, ROLES.SUPER_ADMIN];

async function listEmployees(businessId, { page, limit, search }) {
  const filter = { businessId };
  if (search) {
    filter.$or = [
      { name: new RegExp(search, 'i') },
      { phone: new RegExp(search, 'i') },
      { email: new RegExp(search, 'i') },
      { employeeCode: new RegExp(search, 'i') },
    ];
  }

  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    User.countDocuments(filter),
  ]);

  return { items: items.map((u) => ({ ...u.toSafeJSON(), permissionSummary: { mode: require('../utils/permissionResolver').modeOf(u), groups: (u.permissionGroupIds || []).length, overrides: (u.grantedPermissions || []).length + (u.revokedPermissions || []).length } })), total, page, limit, pages: Math.ceil(total / limit) };
}

async function getEmployee(businessId, userId) {
  const user = await User.findOne({ _id: userId, businessId });
  if (!user) throw ApiError.notFound('Employee not found');
  return user;
}

async function createEmployee(businessId, createdBy, data, actor, meta) {
  if (RESERVED_ROLES.includes(data.role)) {
    throw ApiError.badRequest('This role cannot be assigned this way', 'INVALID_ROLE');
  }

  data = { ...data, phone: await resolvePhone(businessId, data.phone) };

  const secret = data.pin || data.password;
  if (!secret) {
    throw ApiError.badRequest('Either password or pin is required', 'CREDENTIAL_REQUIRED');
  }

  const passwordHash = data.password
    ? await User.hashSecret(data.password)
    : await User.hashSecret(crypto.randomBytes(24).toString('hex'));
  const pinHash = data.pin ? await User.hashSecret(data.pin) : undefined;

  const user = await User.create({
    businessId,
    name: data.name,
    email: data.email,
    phone: data.phone,
    role: data.role,
    employeeCode: data.employeeCode,
    branchIds: data.branchIds || [],
    passwordHash,
    pinHash,
    createdBy,
  });

  // Optional: choose the new hire's access in the same request (groups / extra grants / revokes).
  if (data.access && Object.keys(data.access).length) {
    if (!actor || !require('../utils/permissionResolver').userHasPermission(actor, 'employees.permissions')) {
      await User.deleteOne({ _id: user._id });
      throw ApiError.forbidden('You are not allowed to set permissions', 'PERMISSION_DENIED');
    }
    try { await require('./permission.service').applyToNewEmployee(businessId, actor, user, data.access, meta); }
    catch (e) { await User.deleteOne({ _id: user._id }); throw e; }
  }

  await AuditLog.create({
    businessId,
    userId: createdBy,
    action: 'employee.create',
    entityType: 'User',
    entityId: user._id,
    newValue: { name: user.name, role: user.role, phone: user.phone },
  });

  if (user.email) {
    (async () => {
      const Business = require('../models/Business');
      const [business, actor] = await Promise.all([Business.findById(businessId).select('name').lean(), User.findById(createdBy).select('name').lean()]);
      if (business) await require('./authMail.service').sendEmployeeWelcome({ user, business, addedBy: actor && actor.name, kind: data.pin ? 'pin' : 'password' });
    })().catch((e) => console.error('[mail] employee welcome failed', e.message));
  }

  return user;
}

async function updateEmployee(businessId, actorId, userId, updates) {
  const user = await User.findOne({ _id: userId, businessId });
  if (!user) throw ApiError.notFound('Employee not found');

  if (updates.role === ROLES.SUPER_ADMIN) {
    throw ApiError.badRequest('This role cannot be assigned this way', 'INVALID_ROLE');
  }
  if (user.role === ROLES.OWNER && updates.role && updates.role !== ROLES.OWNER) {
    throw ApiError.badRequest('Cannot change the OWNER role', 'INVALID_ROLE_CHANGE');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'phone')) updates = { ...updates, phone: await resolvePhone(businessId, updates.phone) };

  const oldValue = { name: user.name, role: user.role, branchIds: user.branchIds };

  // Permissions are NOT editable here any more: they go through services/permission.service.js, which enforces the anti-escalation rules.
  const editable = ['name', 'email', 'phone', 'role', 'branchIds', 'employeeCode'];
  for (const field of editable) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      user[field] = updates[field];
    }
  }

  await user.save();

  await AuditLog.create({
    businessId,
    userId: actorId,
    action: 'employee.update',
    entityType: 'User',
    entityId: user._id,
    oldValue,
    newValue: { name: user.name, role: user.role, branchIds: user.branchIds },
  });

  return user;
}

async function setEmployeeStatus(businessId, actorId, userId, status) {
  const user = await User.findOne({ _id: userId, businessId });
  if (!user) throw ApiError.notFound('Employee not found');
  if (user.role === ROLES.OWNER) throw ApiError.badRequest('Cannot deactivate the OWNER account', 'CANNOT_DEACTIVATE_OWNER');

  user.status = status;
  if (status !== 'active') user.refreshTokenVersion += 1; // force logout
  await user.save();

  await AuditLog.create({
    businessId,
    userId: actorId,
    action: 'employee.status_change',
    entityType: 'User',
    entityId: user._id,
    newValue: { status },
  });

  return user;
}

async function deleteEmployee(businessId, actorId, userId) {
  // Financial/audit integrity: never hard-delete a user who may be referenced
  // by historical sales, shifts, etc. Deactivate instead.
  return setEmployeeStatus(businessId, actorId, userId, 'inactive');
}

module.exports = {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  setEmployeeStatus,
  deleteEmployee,
};