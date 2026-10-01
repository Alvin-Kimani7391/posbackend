const CashShift = require('../models/CashShift');
const CashRegister = require('../models/CashRegister');
const Payment = require('../models/Payment');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { fromCents } = require('../utils/money');
const { normalizeDenominations, denominationsTotalCents } = require('../utils/denominations');
const notificationService = require('./notification.service');
const shortageService = require('./shortage.service');

async function getCurrentShift(businessId, branchId, cashierId) {
  return CashShift.findOne({ businessId, branchId, cashierId, status: 'OPEN' }).populate('registerId', 'name code');
}

async function listShifts(businessId, { branchId, cashierId, status, from, to, page, limit }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (cashierId) filter.cashierId = cashierId;
  if (status) filter.status = status;
  if (from || to) {
    filter.openedAt = {};
    if (from) filter.openedAt.$gte = from;
    if (to) filter.openedAt.$lte = to;
  }

  const [items, total] = await Promise.all([
    CashShift.find(filter)
      .populate('cashierId', 'name')
      .populate('closedBy', 'name')
      .populate('registerId', 'name code')
      .populate('branchId', 'name')
      .sort({ openedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CashShift.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getShift(businessId, id) {
  const shift = await CashShift.findOne({ _id: id, businessId })
    .populate('cashierId', 'name')
    .populate('closedBy', 'name')
    .populate('registerId', 'name code')
    .populate('branchId', 'name');
  if (!shift) throw ApiError.notFound('Shift not found');
  return shift;
}

/** Shift + every successful cash payment taken during it (decimal KES, ready for the API). */
async function getShiftDetail(businessId, id) {
  const shift = await getShift(businessId, id);
  const payments = await Payment.find({ businessId, shiftId: shift._id, method: 'CASH', status: 'SUCCESS' })
    .populate('saleId', 'receiptNumber')
    .sort({ createdAt: 1 });

  const cashSales = payments.map((p) => ({
    saleId: p.saleId?._id,
    receiptNumber: p.saleId?.receiptNumber,
    amount: fromCents(p.amount),
    amountTendered: p.amountTendered != null ? fromCents(p.amountTendered) : null,
    changeGiven: p.changeGiven != null ? fromCents(p.changeGiven) : null,
    createdAt: p.createdAt,
  }));

  return { shift, cashSales };
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

async function closeShift(businessId, userId, id, { denominations, actualCash, notes }) {
  const shift = await CashShift.findOne({ _id: id, businessId }).populate('registerId', 'name code');
  if (!shift) throw ApiError.notFound('Shift not found');
  if (shift.status !== 'OPEN') throw ApiError.conflict('Shift is already closed', 'SHIFT_ALREADY_CLOSED');

  // The counted total is ALWAYS derived from the denomination count, so the two can never disagree.
  const countedDenominations = normalizeDenominations(denominations);
  const countedCents = denominationsTotalCents(countedDenominations);
  if (actualCash !== undefined && actualCash !== countedCents) {
    throw ApiError.badRequest('Counted total does not match the denomination breakdown', 'DENOMINATION_MISMATCH');
  }

  const cashPayments = await Payment.find({ businessId, shiftId: shift._id, method: 'CASH', status: { $in: ['SUCCESS'] } })
    .populate('saleId', 'receiptNumber');
  const cashTotal = cashPayments.reduce((sum, p) => sum + p.amount, 0);

  const expectedCash = shift.openingCash + cashTotal;
  const cashDifference = countedCents - expectedCash;

  shift.closingCash = expectedCash;
  shift.expectedCash = expectedCash;
  shift.actualCash = countedCents;
  shift.cashDifference = cashDifference;
  shift.denominations = countedDenominations;
  shift.status = 'CLOSED';
  shift.closedAt = new Date();
  shift.closedBy = userId;
  shift.notes = notes;
  await shift.save();

  await AuditLog.create({
    businessId,
    branchId: shift.branchId,
    userId,
    action: 'shift.close',
    entityType: 'CashShift',
    entityId: shift._id,
    newValue: { expectedCash, actualCash: countedCents, cashDifference, denominations: countedDenominations.filter((d) => d.count > 0) },
  });

  // A SHORT drawer becomes a trackable debt against the cashier who ran it.
  // Never fail the close over this - the unique index on shiftId plus
  // shortageService.backfillFromShifts() can always recreate a missed record.
  if (cashDifference < 0) {
    try {
      await shortageService.recordForShift(shift);
    } catch (err) {
      console.error('recordForShift failed', err);
    }
  }

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

module.exports = { getCurrentShift, listShifts, getShift, getShiftDetail, openShift, closeShift };