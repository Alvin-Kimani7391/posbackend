const AuditLog = require('../models/AuditLog');

async function listAuditLogs(businessId, { branchId, userId, action, entityType, from, to, page, limit }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (userId) filter.userId = userId;
  if (action) filter.action = new RegExp(`^${action}`, 'i'); // e.g. "sale" matches "sale.create", "sale.cancel"
  if (entityType) filter.entityType = entityType;
  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = new Date(from);
    if (to) filter.timestamp.$lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .populate('userId', 'name role')
      .populate('branchId', 'name')
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AuditLog.countDocuments(filter),
  ]);

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

module.exports = { listAuditLogs };