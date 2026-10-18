/** Staff duty / rosters, shift handover, tips, incidents and the waste log. */
const RestaurantShift = require('../../models/RestaurantShift');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantBill = require('../../models/RestaurantBill');
const RestaurantTable = require('../../models/RestaurantTable');
const TipRecord = require('../../models/TipRecord');
const ServiceIncident = require('../../models/ServiceIncident');
const WasteRecord = require('../../models/WasteRecord');
const CashShift = require('../../models/CashShift');
const User = require('../../models/User');
const ApiError = require('../../utils/ApiError');
const { allocate } = require('../../utils/restaurantBilling');
const C = require('./common');

// ---------------- duty
async function schedule(businessId, user, { userId, branchId, scheduledStart, scheduledEnd, role, notes }) {
  C.assertBranchAccess(user, branchId);
  const u = await User.findOne({ _id: userId, businessId, status: 'active' }).select('role'); if (!u) throw ApiError.badRequest('Staff member not found', 'USER_NOT_FOUND');
  if (new Date(scheduledEnd) <= new Date(scheduledStart)) throw ApiError.badRequest('End must be after start', 'INVALID_TIME');
  return RestaurantShift.create({ businessId, branchId, userId, role: role || u.role, scheduledStart, scheduledEnd, notes, createdBy: user._id });
}
async function listShifts(businessId, user, { branchId, userId, status, from, to, page = 1, limit = 50 }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (!C.can(user, 'restaurant.shifts.view')) f.userId = user._id; else if (userId) f.userId = userId;
  if (status) f.status = status;
  if (from || to) { f.$or = [{ scheduledStart: {} }, { clockIn: {} }]; if (from) { f.$or[0].scheduledStart.$gte = new Date(from); f.$or[1].clockIn.$gte = new Date(from); } if (to) { f.$or[0].scheduledStart.$lte = new Date(to); f.$or[1].clockIn.$lte = new Date(to); } }
  const [items, total] = await Promise.all([RestaurantShift.find(f).populate('userId', 'name role').sort({ scheduledStart: -1, clockIn: -1 }).skip((page - 1) * limit).limit(limit), RestaurantShift.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}
async function clockIn(businessId, user, { branchId, acceptingTables = true }) {
  C.assertBranchAccess(user, branchId);
  if (await RestaurantShift.exists({ businessId, userId: user._id, status: { $in: ['ON_DUTY', 'BREAK', 'UNAVAILABLE'] } })) throw ApiError.conflict('You are already on duty', 'ALREADY_ON_DUTY');
  const cash = await CashShift.findOne({ businessId, branchId, cashierId: user._id, status: 'OPEN' }).select('_id');
  const now = new Date();
  const planned = await RestaurantShift.findOne({ businessId, userId: user._id, branchId, status: 'SCHEDULED', scheduledEnd: { $gt: now }, scheduledStart: { $lte: new Date(now.getTime() + 4 * 3600000) } }).sort({ scheduledStart: 1 });
  const s = planned || new RestaurantShift({ businessId, branchId, userId: user._id, role: user.role });
  Object.assign(s, { status: 'ON_DUTY', clockIn: now, acceptingTables, cashShiftId: cash?._id }); await s.save();
  await C.audit({ businessId, branchId, userId: user._id, action: 'restaurant.duty.start', entityType: 'RestaurantShift', entityId: s._id });
  return s;
}
async function clockOut(businessId, user, { force } = {}) {
  const s = await RestaurantShift.findOne({ businessId, userId: user._id, status: { $in: ['ON_DUTY', 'BREAK', 'UNAVAILABLE'] } });
  if (!s) throw ApiError.badRequest('You are not on duty', 'NOT_ON_DUTY');
  const open = await RestaurantOrder.countDocuments({ businessId, waiterId: user._id, status: 'OPEN' });
  if (open && !(force && C.can(user, 'restaurant.shifts.manage'))) throw ApiError.conflict(`You still have ${open} open order(s). Hand them over first.`, 'OPEN_ORDERS');
  s.status = 'COMPLETED'; s.clockOut = new Date(); await s.save();
  await C.audit({ businessId, branchId: s.branchId, userId: user._id, action: 'restaurant.duty.end', entityType: 'RestaurantShift', entityId: s._id });
  return s;
}
async function setAvailability(businessId, user, { status, acceptingTables }) {
  const s = await RestaurantShift.findOne({ businessId, userId: user._id, status: { $in: ['ON_DUTY', 'BREAK', 'UNAVAILABLE'] } });
  if (!s) throw ApiError.badRequest('You are not on duty', 'NOT_ON_DUTY');
  if (status) s.status = status; if (acceptingTables !== undefined) s.acceptingTables = acceptingTables; await s.save(); return s;
}
const onDuty = (businessId, user, { branchId }) => RestaurantShift.find({ businessId, ...C.branchFilter(C.branchScope(user, branchId)), status: { $in: ['ON_DUTY', 'BREAK', 'UNAVAILABLE'] } }).populate('userId', 'name role');

/** Moves the caller's (or, for a supervisor, another waiter's) open orders and table assignments to someone else, with an audit trail. */
async function handover(businessId, user, { fromUserId, toUserId, orderIds, note }) {
  const from = fromUserId && String(fromUserId) !== String(user._id) ? fromUserId : user._id;
  if (!C.sameId(from, user._id)) C.requireCan(user, 'restaurant.shifts.manage', 'Only a supervisor can hand over another waiter\'s tables');
  return C.inTx(async (session) => {
    const to = await User.findOne({ _id: toUserId, businessId, status: 'active' }).select('name').session(session); if (!to) throw ApiError.badRequest('Staff member not found', 'USER_NOT_FOUND');
    const f = { businessId, waiterId: from, status: 'OPEN' }; if (orderIds?.length) f._id = { $in: orderIds };
    const orders = await RestaurantOrder.find(f).session(session);
    for (const o of orders) C.assertBranchAccess(user, o.branchId);
    for (const o of orders) {
      o.waiterId = to._id; o.waiterName = to.name; C.touch(o, user._id, 'order.handover', note, { from, to: to._id }); await o.save({ session });
      if (o.tableId) await RestaurantTable.updateOne({ _id: o.tableId }, { $set: { waiterId: to._id } }, { session });
      await RestaurantBill.updateMany({ orderId: o._id, status: { $in: ['OPEN', 'PARTIAL'] } }, { $set: { waiterId: to._id, waiterName: to.name } }, { session });
    }
    await C.audit({ businessId, userId: user._id, action: 'restaurant.handover', entityType: 'User', entityId: to._id, newValue: { from, to: to._id, orders: orders.map((o) => o.orderNumber), note } }, session);
    if (orders.length) C.notifyUser(businessId, to._id, { type: 'ORDER_HANDOVER', title: `${orders.length} order(s) handed to you`, message: orders.map((o) => o.tableName || o.orderNumber).join(', '), entityType: 'User', entityId: to._id });
    return { handedOver: orders.length, orders: orders.map((o) => ({ _id: o._id, orderNumber: o.orderNumber, tableName: o.tableName })) };
  });
}

// ---------------- tips
async function listTips(businessId, user, { branchId, waiterId, status, from, to, page = 1, limit = 50 }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (!C.can(user, 'restaurant.tips.manage')) f.$or = [{ waiterId: user._id }, { 'allocations.userId': user._id }]; else if (waiterId) f.waiterId = waiterId;
  if (status) f.status = status;
  if (from || to) { f.createdAt = {}; if (from) f.createdAt.$gte = new Date(from); if (to) f.createdAt.$lte = new Date(to); }
  const [items, total, agg] = await Promise.all([TipRecord.find(f).populate('waiterId', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), TipRecord.countDocuments(f), TipRecord.aggregate([{ $match: { ...f, businessId: C.oid(businessId) } }, { $group: { _id: '$status', amount: { $sum: '$amount' } } }])]);
  return { ...C.paged(items, total, { page, limit }), totals: Object.fromEntries(agg.map((a) => [a._id, a.amount / 100])) };
}
/** INDIVIDUAL mode: each tip goes to the waiter on the bill. POOL mode: tips in the window are shared equally between staff who were on duty. */
async function allocateTips(businessId, user, { branchId, from, to }) {
  C.assertBranchAccess(user, branchId);
  const ctx = await C.getContext(businessId);
  const tips = await TipRecord.find({ businessId, branchId, status: 'RECORDED', createdAt: { $gte: new Date(from), $lte: new Date(to) } });
  if (!tips.length) return { allocated: 0, total: 0 };
  let pool = [];
  if (ctx.settings.tips.mode === 'POOL') {
    const shifts = await RestaurantShift.find({ businessId, branchId, clockIn: { $lte: new Date(to) }, $or: [{ clockOut: null }, { clockOut: { $gte: new Date(from) } }] }).populate('userId', 'role');
    pool = [...new Set(shifts.filter((s) => (ctx.settings.tips.poolRoles || []).includes(s.userId?.role)).map((s) => String(s.userId._id)))];
    if (!pool.length) throw ApiError.badRequest('Nobody from the tip pool was on duty in that period', 'EMPTY_POOL');
  }
  let total = 0;
  for (const t of tips) {
    const shares = ctx.settings.tips.mode === 'POOL' ? allocate(t.amount, pool.map(() => 1)) : [t.amount];
    const targets = ctx.settings.tips.mode === 'POOL' ? pool : [String(t.waiterId)];
    if (!targets[0] || targets[0] === 'undefined') continue;
    t.allocations = targets.map((u, i) => ({ userId: u, amount: shares[i] })); t.status = 'ALLOCATED'; await t.save(); total += t.amount;
  }
  await C.audit({ businessId, branchId, userId: user._id, action: 'restaurant.tips.allocate', newValue: { from, to, total, mode: ctx.settings.tips.mode } });
  return { allocated: tips.length, total: total / 100 };
}
async function payoutTips(businessId, user, { tipIds }) {
  const r = await TipRecord.updateMany({ _id: { $in: tipIds }, businessId, status: 'ALLOCATED' }, { $set: { status: 'PAID_OUT', paidOutAt: new Date(), paidOutBy: user._id } });
  await C.audit({ businessId, userId: user._id, action: 'restaurant.tips.payout', newValue: { count: r.modifiedCount } });
  return { paidOut: r.modifiedCount };
}
async function tipSummary(businessId, user, { branchId, from, to }) {
  const m = { businessId: C.oid(businessId), ...C.branchFilter(C.branchScope(user, branchId)), createdAt: { $gte: new Date(from || 0), $lte: new Date(to || Date.now()) } };
  const rows = await TipRecord.aggregate([{ $match: m }, { $unwind: '$allocations' }, { $group: { _id: '$allocations.userId', amount: { $sum: '$allocations.amount' }, paidOut: { $sum: { $cond: [{ $eq: ['$status', 'PAID_OUT'] }, '$allocations.amount', 0] } } } }, { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } }, { $project: { _id: 0, userId: '$_id', name: { $arrayElemAt: ['$u.name', 0] }, amount: 1, paidOut: 1 } }]);
  return rows.map((r) => ({ ...r, amount: r.amount / 100, paidOut: r.paidOut / 100, owing: (r.amount - r.paidOut) / 100 }));
}

// ---------------- incidents
async function createIncident(businessId, user, input) {
  C.assertBranchAccess(user, input.branchId);
  let ref = {}; if (input.orderId) { const o = await C.loadOrder(businessId, input.orderId); C.assertOrderAccess(user, o); ref = { orderNumber: o.orderNumber, tableName: o.tableName }; }
  const inc = await ServiceIncident.create({ ...input, ...ref, businessId, raisedBy: user._id });
  if (['COMPLAINT', 'ALLERGY'].includes(input.type) || input.severity === 'HIGH') C.notifyRoles(businessId, input.branchId, C.FLOOR_LEAD_ROLES, { type: 'SERVICE_INCIDENT', title: `${input.type}: ${ref.tableName || ref.orderNumber || ''}`, message: input.description, entityType: 'ServiceIncident', entityId: inc._id });
  return inc;
}
async function listIncidents(businessId, user, { branchId, status, type, page = 1, limit = 30 }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) }; if (status) f.status = status; if (type) f.type = type;
  if (!C.can(user, 'restaurant.incidents.manage')) f.raisedBy = user._id;
  const [items, total] = await Promise.all([ServiceIncident.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), ServiceIncident.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}
async function resolveIncident(businessId, user, id, { resolution, compensation }) {
  const i = await ServiceIncident.findOne({ _id: id, businessId }); if (!i) throw ApiError.notFound('Incident not found');
  C.assertBranchAccess(user, i.branchId);
  if (i.status === 'RESOLVED') throw ApiError.conflict('Already resolved', 'ALREADY_RESOLVED');
  Object.assign(i, { status: 'RESOLVED', resolution, compensation, resolvedBy: user._id, resolvedAt: new Date() }); await i.save(); return i;
}

// ---------------- waste log
async function listWaste(businessId, user, { branchId, kind, from, to, page = 1, limit = 50 }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) }; if (kind) f.kind = kind;
  if (from || to) { f.createdAt = {}; if (from) f.createdAt.$gte = new Date(from); if (to) f.createdAt.$lte = new Date(to); }
  const [items, total, agg] = await Promise.all([WasteRecord.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), WasteRecord.countDocuments(f), WasteRecord.aggregate([{ $match: { ...f, businessId: C.oid(businessId) } }, { $group: { _id: '$kind', cost: { $sum: '$cost' }, count: { $sum: 1 } } }])]);
  return { ...C.paged(items, total, { page, limit }), byKind: agg.map((a) => ({ kind: a._id, count: a.count, cost: a.cost / 100 })) };
}

module.exports = { schedule, listShifts, clockIn, clockOut, setAvailability, onDuty, handover, listTips, allocateTips, payoutTips, tipSummary, createIncident, listIncidents, resolveIncident, listWaste };
