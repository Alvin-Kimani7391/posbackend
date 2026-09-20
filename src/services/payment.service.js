const Payment = require('../models/Payment');
const ApiError = require('../utils/ApiError');

async function listPayments(businessId, { branchId, saleId, customerId, method, status, shiftId, from, to, page, limit }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (saleId) filter.saleId = saleId;
  if (customerId) filter.customerId = customerId;
  if (method) filter.method = method;
  if (status) filter.status = status;
  if (shiftId) filter.shiftId = shiftId;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    Payment.find(filter)
      .populate('customerId', 'name phone')
      .populate('initiatedBy', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Payment.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getPayment(businessId, id) {
  const payment = await Payment.findOne({ _id: id, businessId }).populate('customerId', 'name phone').populate('initiatedBy', 'name');
  if (!payment) throw ApiError.notFound('Payment not found');
  return payment;
}

module.exports = { listPayments, getPayment };
