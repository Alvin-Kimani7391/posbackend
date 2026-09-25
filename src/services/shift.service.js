const CashShift = require('../models/CashShift');
const CashRegister = require('../models/CashRegister');
const Payment = require('../models/Payment');
const User = require('../models/User');              // <-- add this
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');

async function getCurrentShift(businessId, branchId, cashierId) {
  return CashShift.findOne({ businessId, branchId, cashierId, status: 'OPEN' }).populate('registerId', 'name code');
}

async function listShifts(businessId, { branchId, cashierId, status, page, limit }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (cashierId) filter.cashierId = cashierId;
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    CashShift.find(filter).populate('cashierId', 'name').populate('registerId', 'name code').sort({ openedAt: -1 }).skip((page - 1) * limit).limit(limit),
    CashShift.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getShift(businessId, id) {
  const shift = await CashShift.findOne({ _id: id, businessId }).populate('cashierId', 'name').populate('registerId', 'name code');
  if (!shift) throw ApiError.notFound('Shift not found');
  return shift;
}

async function openShift(businessId, branchId, cashierId, { registerId, openingCash }) {
  const register = await CashRegister.findOne({ _id: registerId, businessId, branchId, status: 'active' });
  if (!register) throw ApiError.badRequest('Register not found or inactive', 'INVALID_REGISTER');

  const [existingForCashier, existingForRegister] = await Promise.all([
    CashShift.findOne({ businessId, cashierId, status: 'OPEN' }),
    CashShift.findOne({ businessId, registerId, status: 'OPEN' }),
  ]);
  if (existingForCashier) throw ApiError.conflict('You already have an open shift', 'SHIFT_ALREADY_OPEN');
  if (existingForRegister) throw ApiError.conflict('This register already has an open shift', 'REGISTER_IN_USE');

  const shift = await CashShift.create({ businessId, branchId, registerId, cashierId, openingCash, status: 'OPEN' });
  await AuditLog.create({ businessId, branchId, userId: cashierId, action: 'shift.open', entityType: 'CashShift', entityId: shift._id, newValue: { openingCash } });

  const [cashier] = await Promise.all([User.findById(cashierId).select('name role'), shift.populate('registerId', 'name code')]);
  notificationService.notifyShiftOpened(businessId, branchId, shift, cashier)
    .catch((err) => console.error('notifyShiftOpened failed', err));

  return shift;
}

async function closeShift(businessId, userId, id, { actualCash, notes }) {
  const shift = await CashShift.findOne({ _id: id, businessId }).populate('registerId', 'name code');
  if (!shift) throw ApiError.notFound('Shift not found');
  if (shift.status !== 'OPEN') throw ApiError.conflict('Shift is already closed', 'SHIFT_ALREADY_CLOSED');

  const cashPayments = await Payment.find({ businessId, shiftId: shift._id, method: 'CASH', status: { $in: ['SUCCESS'] } })
    .populate('saleId', 'receiptNumber');
  const cashTotal = cashPayments.reduce((sum, p) => sum + p.amount, 0);

  const expectedCash = shift.openingCash + cashTotal;
  const cashDifference = actualCash - expectedCash;

  shift.closingCash = expectedCash;
  shift.expectedCash = expectedCash;
  shift.actualCash = actualCash;
  shift.cashDifference = cashDifference;
  shift.status = 'CLOSED';
  shift.closedAt = new Date();
  shift.notes = notes;
  await shift.save();

  await AuditLog.create({ businessId, branchId: shift.branchId, userId, action: 'shift.close', entityType: 'CashShift', entityId: shift._id, newValue: { expectedCash, actualCash, cashDifference } });

    const cashier = await User.findById(userId).select('name role');
  const saleBreakdown = cashPayments.map((p) => ({
    saleId: p.saleId?._id,
    receiptNumber: p.saleId?.receiptNumber,
    amount: p.amount,
    amountTendered: p.amountTendered,
    changeGiven: p.changeGiven,
    createdAt: p.createdAt,
  }));
  notificationService.notifyShiftClosed(businessId, shift.branchId, shift, cashier, saleBreakdown)
    .catch((err) => console.error('notifyShiftClosed failed', err));

  return shift;
}

module.exports = { getCurrentShift, listShifts, getShift, openShift, closeShift };