const CashRegister = require('../models/CashRegister');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

async function listRegisters(businessId, branchId) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  return CashRegister.find(filter).sort({ name: 1 });
}

async function createRegister(businessId, userId, data) {
  const register = await CashRegister.create({ ...data, businessId });
  await AuditLog.create({ businessId, branchId: data.branchId, userId, action: 'register.create', entityType: 'CashRegister', entityId: register._id, newValue: { name: register.name, code: register.code } });
  return register;
}

async function updateRegister(businessId, userId, id, updates) {
  const register = await CashRegister.findOne({ _id: id, businessId });
  if (!register) throw ApiError.notFound('Register not found');

  Object.assign(register, updates);
  await register.save();

  await AuditLog.create({ businessId, branchId: register.branchId, userId, action: 'register.update', entityType: 'CashRegister', entityId: register._id });
  return register;
}

module.exports = { listRegisters, createRegister, updateRegister };
