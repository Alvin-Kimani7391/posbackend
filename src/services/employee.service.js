const crypto = require('crypto');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');

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

  return { items: items.map((u) => u.toSafeJSON()), total, page, limit, pages: Math.ceil(total / limit) };
}

async function getEmployee(businessId, userId) {
  const user = await User.findOne({ _id: userId, businessId });
  if (!user) throw ApiError.notFound('Employee not found');
  return user;
}

async function createEmployee(businessId, createdBy, data) {
  if (data.role === ROLES.OWNER) {
    throw ApiError.badRequest('Cannot create a second OWNER account this way', 'INVALID_ROLE');
  }

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

  await AuditLog.create({
    businessId,
    userId: createdBy,
    action: 'employee.create',
    entityType: 'User',
    entityId: user._id,
    newValue: { name: user.name, role: user.role, phone: user.phone },
  });

  return user;
}

async function updateEmployee(businessId, actorId, userId, updates) {
  const user = await User.findOne({ _id: userId, businessId });
  if (!user) throw ApiError.notFound('Employee not found');
  if (user.role === ROLES.OWNER && updates.role && updates.role !== ROLES.OWNER) {
    throw ApiError.badRequest('Cannot change the OWNER role', 'INVALID_ROLE_CHANGE');
  }

  const oldValue = { name: user.name, role: user.role, branchIds: user.branchIds };

  const editable = ['name', 'email', 'phone', 'role', 'branchIds', 'employeeCode', 'grantedPermissions', 'revokedPermissions'];
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
