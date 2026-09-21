const Supplier = require('../models/Supplier');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

async function listSuppliers(businessId, { page, limit, search }) {
  const filter = { businessId };
  if (search) {
    filter.$or = [{ name: new RegExp(search, 'i') }, { phone: new RegExp(search, 'i') }];
  }
  const [items, total] = await Promise.all([
    Supplier.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Supplier.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getSupplier(businessId, id) {
  const supplier = await Supplier.findOne({ _id: id, businessId });
  if (!supplier) throw ApiError.notFound('Supplier not found');
  return supplier;
}

async function createSupplier(businessId, userId, data) {
  const supplier = await Supplier.create({ ...data, businessId });
  await AuditLog.create({ businessId, userId, action: 'supplier.create', entityType: 'Supplier', entityId: supplier._id, newValue: { name: supplier.name } });
  return supplier;
}

async function updateSupplier(businessId, userId, id, updates) {
  const supplier = await Supplier.findOne({ _id: id, businessId });
  if (!supplier) throw ApiError.notFound('Supplier not found');

  const { currentBalance, ...safeUpdates } = updates; // balance only ever changes via purchase/payment flows
  Object.assign(supplier, safeUpdates);
  await supplier.save();

  await AuditLog.create({ businessId, userId, action: 'supplier.update', entityType: 'Supplier', entityId: supplier._id });
  return supplier;
}

module.exports = { listSuppliers, getSupplier, createSupplier, updateSupplier };
