const Branch = require('../models/Branch');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

async function listBranches(businessId, { page, limit, search }) {
  const filter = { businessId };
  if (search) {
    filter.$or = [
      { name: new RegExp(search, 'i') },
      { code: new RegExp(search, 'i') },
    ];
  }

  const [items, total] = await Promise.all([
    Branch.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Branch.countDocuments(filter),
  ]);

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getBranch(businessId, branchId) {
  const branch = await Branch.findOne({ _id: branchId, businessId });
  if (!branch) throw ApiError.notFound('Branch not found');
  return branch;
}

async function createBranch(businessId, userId, data) {
  const branch = await Branch.create({ ...data, businessId });
  await AuditLog.create({
    businessId,
    branchId: branch._id,
    userId,
    action: 'branch.create',
    entityType: 'Branch',
    entityId: branch._id,
    newValue: branch.toObject(),
  });
  return branch;
}

async function updateBranch(businessId, userId, branchId, updates) {
  const branch = await Branch.findOne({ _id: branchId, businessId });
  if (!branch) throw ApiError.notFound('Branch not found');

  const oldValue = branch.toObject();
  Object.assign(branch, updates);
  await branch.save();

  await AuditLog.create({
    businessId,
    branchId,
    userId,
    action: 'branch.update',
    entityType: 'Branch',
    entityId: branch._id,
    oldValue,
    newValue: branch.toObject(),
  });

  return branch;
}

async function deleteBranch(businessId, userId, branchId) {
  const branch = await Branch.findOne({ _id: branchId, businessId });
  if (!branch) throw ApiError.notFound('Branch not found');
  if (branch.isMainBranch) throw ApiError.badRequest('Cannot delete the main branch', 'CANNOT_DELETE_MAIN_BRANCH');

  // Soft delete: branches with historical transactions must never be hard-deleted.
  branch.status = 'inactive';
  await branch.save();

  await AuditLog.create({
    businessId,
    branchId,
    userId,
    action: 'branch.deactivate',
    entityType: 'Branch',
    entityId: branch._id,
  });

  return branch;
}

module.exports = { listBranches, getBranch, createBranch, updateBranch, deleteBranch };
