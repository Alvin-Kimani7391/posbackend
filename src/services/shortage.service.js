const mongoose = require('mongoose');
const CashierShortage = require('../models/CashierShortage');
const ShortagePayment = require('../models/ShortagePayment');
const CashShift = require('../models/CashShift');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { fromCents } = require('../utils/money');
const notificationService = require('./notification.service');

// aggregate() does not auto-cast ids (see report.service.js) - cast explicitly.
function toObjectId(id) {
  if (!id) return id;
  if (id instanceof mongoose.Types.ObjectId) return id;
  try { return new mongoose.Types.ObjectId(String(id)); } catch { return id; }
}

/**
 * recordForShift - called when a shift closes. Does nothing unless the drawer
 * was SHORT. Idempotent (unique index on shiftId), so safe to call twice.
 */
async function recordForShift(shift) {
  if (!(shift.cashDifference < 0)) return null;
  const amount = Math.abs(shift.cashDifference);
  try {
    return await CashierShortage.create({
      businessId: shift.businessId,
      branchId: shift.branchId,
      shiftId: shift._id,
      registerId: shift.registerId?._id || shift.registerId,
      cashierId: shift.cashierId,
      closedBy: shift.closedBy,
      amount,
      amountPaid: 0,
      balance: amount,
      status: 'OUTSTANDING',
      incurredAt: shift.closedAt || new Date(),
    });
  } catch (err) {
    if (err.code === 11000) return CashierShortage.findOne({ shiftId: shift._id });
    throw err;
  }
}

/** One-off: create records for shifts that closed short BEFORE this feature existed. */
async function backfillFromShifts(businessId) {
  const shifts = await CashShift.find({ businessId, status: 'CLOSED', cashDifference: { $lt: 0 } });
  let created = 0;
  for (const s of shifts) {
    const exists = await CashierShortage.exists({ shiftId: s._id });
    if (!exists) { await recordForShift(s); created += 1; }
  }
  return { scanned: shifts.length, created };
}

async function listShortages(businessId, { branchId, cashierId, status, from, to, page = 1, limit = 15 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (cashierId) filter.cashierId = cashierId;
  if (status === 'UNSETTLED') filter.status = { $in: ['OUTSTANDING', 'PARTIAL'] };
  else if (status) filter.status = status;
  if (from || to) {
    filter.incurredAt = {};
    if (from) filter.incurredAt.$gte = from;
    if (to) filter.incurredAt.$lte = to;
  }

  const [items, total] = await Promise.all([
    CashierShortage.find(filter)
      .populate('cashierId', 'name')
      .populate('registerId', 'name code')
      .populate('branchId', 'name')
      .populate('shiftId', 'openedAt closedAt')
      .sort({ incurredAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CashierShortage.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getShortage(businessId, id) {
  const shortage = await CashierShortage.findOne({ _id: id, businessId })
    .populate('cashierId', 'name')
    .populate('registerId', 'name code')
    .populate('branchId', 'name')
    .populate('shiftId', 'openedAt closedAt');
  if (!shortage) throw ApiError.notFound('Shortage not found');

  const payments = await ShortagePayment.find({ businessId, shortageId: shortage._id })
    .populate('receivedBy', 'name')
    .sort({ receivedAt: 1 });
  return { shortage, payments };
}

/** Per-cashier running count: how many shortages, total lost, total repaid, still owing. */
async function getCashierSummary(businessId, { branchId, cashierId, from, to }) {
  const match = { businessId: toObjectId(businessId) };
  if (branchId) match.branchId = toObjectId(branchId);
  if (cashierId) match.cashierId = toObjectId(cashierId);
  if (from || to) {
    match.incurredAt = {};
    if (from) match.incurredAt.$gte = new Date(from);
    if (to) match.incurredAt.$lte = new Date(to);
  }

  const rows = await CashierShortage.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$cashierId',
        shortageCount: { $sum: 1 },
        unsettledCount: { $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] } },
        totalLost: { $sum: '$amount' },
        totalPaid: { $sum: '$amountPaid' },
        outstanding: { $sum: '$balance' },
        lastShortageAt: { $max: '$incurredAt' },
      },
    },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'cashier' } },
    { $unwind: { path: '$cashier', preserveNullAndEmptyArrays: true } },
    { $sort: { outstanding: -1, totalLost: -1 } },
  ]);

  const cashiers = rows.map((r) => ({
    cashierId: r._id,
    name: r.cashier?.name || 'Unknown',
    shortageCount: r.shortageCount,
    unsettledCount: r.unsettledCount,
    totalLost: fromCents(r.totalLost),
    totalPaid: fromCents(r.totalPaid),
    outstanding: fromCents(r.outstanding),
    lastShortageAt: r.lastShortageAt,
  }));

  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return {
    cashiers,
    totals: {
      shortageCount: sum('shortageCount'),
      totalLost: fromCents(sum('totalLost')),
      totalPaid: fromCents(sum('totalPaid')),
      outstanding: fromCents(sum('outstanding')),
    },
  };
}

/**
 * recordPayment - a manager/owner records that the cashier repaid (part of)
 * a shortage. Atomic: payment row + shortage totals + audit log commit
 * together. Notifications go out after commit.
 */
async function recordPayment(businessId, actor, id, { amount, method, reference, notes }) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const shortage = await CashierShortage.findOne({ _id: id, businessId }).session(session);
      if (!shortage) throw ApiError.notFound('Shortage not found');
      if (shortage.balance <= 0) throw ApiError.conflict('This shortage is already cleared', 'SHORTAGE_ALREADY_CLEARED');
      if (amount > shortage.balance) {
        throw ApiError.badRequest('Payment is more than the outstanding balance', 'PAYMENT_EXCEEDS_BALANCE');
      }

      const newPaid = shortage.amountPaid + amount;
      const newBalance = shortage.balance - amount;
      const cleared = newBalance === 0;

      shortage.amountPaid = newPaid;
      shortage.balance = newBalance;
      shortage.status = cleared ? 'CLEARED' : 'PARTIAL';
      if (cleared) { shortage.clearedAt = new Date(); shortage.clearedBy = actor._id; }
      await shortage.save({ session });

      const [payment] = await ShortagePayment.create(
        [{
          businessId, branchId: shortage.branchId, shortageId: shortage._id, cashierId: shortage.cashierId,
          amount, balanceAfter: newBalance, method, reference, notes, receivedBy: actor._id,
        }],
        { session }
      );

      await AuditLog.create(
        [{
          businessId, branchId: shortage.branchId, userId: actor._id, action: cleared ? 'shortage.clear' : 'shortage.payment',
          entityType: 'CashierShortage', entityId: shortage._id,
          newValue: { amount, method, reference, balance: newBalance, status: shortage.status },
        }],
        { session }
      );

      result = { shortage, payment };
    });
  } finally {
    session.endSession();
  }

  const cashier = await User.findById(result.shortage.cashierId).select('name role');
  notificationService.notifyShortagePayment(businessId, result.shortage, cashier, actor, result.payment)
    .catch((err) => console.error('notifyShortagePayment failed', err));

  return result;
}

module.exports = { recordForShift, backfillFromShifts, listShortages, getShortage, getCashierSummary, recordPayment };