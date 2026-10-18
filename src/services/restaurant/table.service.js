/** Tables and floor. Table status changes that come from orders go through claimTable/releaseTable so they are atomic. */
const RestaurantTable = require('../../models/RestaurantTable');
const RestaurantOrder = require('../../models/RestaurantOrder');
const Reservation = require('../../models/Reservation');
const RestaurantArea = require('../../models/RestaurantArea');
const User = require('../../models/User');
const ApiError = require('../../utils/ApiError');
const C = require('./common');

const FREE_STATES = ['AVAILABLE'];

async function createTable(businessId, userId, input) {
  await C.assertBranch(businessId, input.branchId);
  if (input.areaId && !(await RestaurantArea.exists({ _id: input.areaId, businessId, branchId: input.branchId }))) throw ApiError.badRequest('Area not found at this branch', 'AREA_NOT_FOUND');
  const t = await RestaurantTable.create({ ...input, businessId });
  await C.audit({ businessId, branchId: t.branchId, userId, action: 'restaurant.table.create', entityType: 'RestaurantTable', entityId: t._id, newValue: { name: t.name, seats: t.seats } });
  return t;
}
async function updateTable(businessId, userId, id, input) {
  const t = await RestaurantTable.findOne({ _id: id, businessId }); if (!t) throw ApiError.notFound('Table not found', 'TABLE_NOT_FOUND');
  if (input.active === false && t.currentOrderId) throw ApiError.conflict('The table has an open order', 'TABLE_OCCUPIED');
  Object.assign(t, input); await t.save();
  await C.audit({ businessId, branchId: t.branchId, userId, action: 'restaurant.table.update', entityType: 'RestaurantTable', entityId: t._id });
  return t;
}

/** Live floor plan: tables with the open order summary, wait time and who serves them. Waiters without view_all see only their own tables. */
async function floor(businessId, user, { branchId, areaId }) {
  C.assertBranchAccess(user, branchId);
  const all = C.can(user, 'restaurant.tables.view_all');
  const f = { businessId, branchId, active: true }; if (areaId) f.areaId = areaId;
  const tables = await RestaurantTable.find(f).populate('areaId', 'name type').populate('waiterId', 'name').sort({ name: 1 });
  const orders = await RestaurantOrder.find({ _id: { $in: tables.map((t) => t.currentOrderId).filter(Boolean) } }).select('orderNumber waiterId waiterName guestCount totals billStatus firstSentAt items.status items.readyAt createdAt priority');
  const byId = new Map(orders.map((o) => [String(o._id), o]));
  const now = Date.now();
  return tables.filter((t) => all || C.sameId(t.waiterId?._id, user._id) || (byId.get(String(t.currentOrderId)) && (C.sameId(byId.get(String(t.currentOrderId)).waiterId, user._id)))).map((t) => {
    const o = t.currentOrderId ? byId.get(String(t.currentOrderId)) : null;
    const live = o ? o.items.filter((i) => i.status !== 'CANCELLED') : [];
    return {
      ...t.toJSON(), occupiedMinutes: t.seatedAt && t.status !== 'AVAILABLE' ? Math.floor((now - t.seatedAt) / 60000) : null,
      order: o ? { _id: o._id, orderNumber: o.orderNumber, waiterName: o.waiterName, guestCount: o.guestCount, total: o.totals.total, billStatus: o.billStatus, priority: o.priority,
        waitingForFoodMinutes: o.firstSentAt && live.some((i) => ['PENDING', 'ACCEPTED', 'PREPARING'].includes(i.status)) ? Math.floor((now - o.firstSentAt) / 60000) : null,
        readyItems: live.filter((i) => i.status === 'READY').length, pendingItems: live.filter((i) => ['PENDING', 'ACCEPTED', 'PREPARING'].includes(i.status)).length } : null,
    };
  });
}

/** Atomically takes a free (or reserved-for-this-party) table for an order. Returns the table or throws TABLE_OCCUPIED. */
async function claimTable({ businessId, tableId, orderId, guestCount, waiterId, allowReserved, allowCleaning, session }) {
  const table = await RestaurantTable.findOne({ _id: tableId, businessId, active: true }).session(session);
  if (!table) throw ApiError.badRequest('Table not found', 'TABLE_NOT_FOUND');
  if (table.combinedInto) throw ApiError.conflict('This table is part of a combined group. Use the main table.', 'TABLE_COMBINED');
  const ok = [...FREE_STATES, ...(allowReserved ? ['RESERVED'] : []), ...(allowCleaning ? ['CLEANING'] : [])];
  const set = { status: 'OCCUPIED', statusSince: new Date(), currentOrderId: orderId, guestCount: guestCount || 0, seatedAt: new Date() };
  if (waiterId) set.waiterId = waiterId;
  const claimed = await RestaurantTable.findOneAndUpdate({ _id: tableId, businessId, status: { $in: ok }, currentOrderId: null }, { $set: set }, { new: true, session });
  if (!claimed) throw ApiError.conflict(`Table ${table.name} is ${table.status.toLowerCase().replace('_', ' ')}${table.currentOrderId ? ' with an open order' : ''}`, 'TABLE_OCCUPIED');
  return claimed;
}

/** Frees a table after its order ends: Cleaning when the restaurant tracks it, else straight back to Available. Also frees combined partners. */
async function releaseTable({ businessId, tableId, settings, session }) {
  if (!tableId) return;
  const t = await RestaurantTable.findOne({ _id: tableId, businessId }).session(session); if (!t) return;
  const next = settings.requireTableCleaning ? 'CLEANING' : 'AVAILABLE';
  await RestaurantTable.updateOne({ _id: t._id }, { $set: { status: next, statusSince: new Date(), currentOrderId: null, guestCount: 0, seatedAt: null } }, { session });
}

async function setStatus(businessId, user, id, { status, reason }) {
  const t = await RestaurantTable.findOne({ _id: id, businessId }); if (!t) throw ApiError.notFound('Table not found', 'TABLE_NOT_FOUND');
  C.assertBranchAccess(user, t.branchId);
  if (t.currentOrderId && ['AVAILABLE', 'CLEANING'].includes(status)) throw ApiError.conflict('The table has an open order. Close or move the order first.', 'TABLE_OCCUPIED');
  if (status === 'OCCUPIED' && !t.currentOrderId) throw ApiError.badRequest('A table becomes occupied by opening an order on it', 'USE_ORDER');
  const from = t.status; t.status = status; t.statusSince = new Date();
  if (status === 'AVAILABLE') { t.guestCount = 0; t.seatedAt = null; }
  await t.save();
  await C.audit({ businessId, branchId: t.branchId, userId: user._id, action: 'restaurant.table.status', entityType: 'RestaurantTable', entityId: t._id, oldValue: { status: from }, newValue: { status, reason } });
  return t;
}

async function assignWaiter(businessId, user, id, { waiterId }) {
  const t = await RestaurantTable.findOne({ _id: id, businessId }); if (!t) throw ApiError.notFound('Table not found', 'TABLE_NOT_FOUND');
  C.assertBranchAccess(user, t.branchId);
  if (waiterId) { const w = await User.findOne({ _id: waiterId, businessId, status: 'active' }).select('_id name'); if (!w) throw ApiError.badRequest('Staff member not found', 'USER_NOT_FOUND'); }
  t.waiterId = waiterId || undefined; await t.save();
  if (t.currentOrderId) await RestaurantOrder.updateOne({ _id: t.currentOrderId, status: 'OPEN' }, { $set: { waiterId: waiterId || undefined }, $inc: { version: 1 } });
  if (waiterId) C.notifyUser(businessId, waiterId, { type: 'TABLE_ASSIGNED', title: `Table ${t.name} assigned to you`, message: `You now look after table ${t.name}.`, branchId: t.branchId, entityType: 'RestaurantTable', entityId: t._id });
  await C.audit({ businessId, branchId: t.branchId, userId: user._id, action: 'restaurant.table.assign', entityType: 'RestaurantTable', entityId: t._id, newValue: { waiterId } });
  return t;
}

/** Combine free tables for a big group. The primary table keeps the order; the others show as combined into it. */
async function combine(businessId, user, { primaryId, tableIds }) {
  return C.inTx(async (session) => {
    const ids = [...new Set(tableIds.map(String))].filter((x) => x !== String(primaryId));
    if (!ids.length) throw ApiError.badRequest('Choose at least one more table', 'NOTHING_TO_COMBINE');
    const primary = await RestaurantTable.findOne({ _id: primaryId, businessId, active: true }).session(session);
    const others = await RestaurantTable.find({ _id: { $in: ids }, businessId, active: true }).session(session);
    if (!primary || others.length !== ids.length) throw ApiError.badRequest('Table not found', 'TABLE_NOT_FOUND');
    C.assertBranchAccess(user, primary.branchId);
    if (primary.combinedInto || primary.combinedWith?.length) throw ApiError.conflict('The main table is already combined', 'TABLE_COMBINED');
    for (const o of others) {
      if (!C.sameId(o.branchId, primary.branchId)) throw ApiError.badRequest('Tables must be at the same branch', 'BRANCH_MISMATCH');
      if (o.combinedInto || o.combinedWith?.length || o.currentOrderId || !['AVAILABLE', 'RESERVED'].includes(o.status)) throw ApiError.conflict(`Table ${o.name} is not free`, 'TABLE_OCCUPIED');
    }
    await RestaurantTable.updateMany({ _id: { $in: ids } }, { $set: { combinedInto: primary._id, status: primary.status === 'AVAILABLE' ? 'AVAILABLE' : 'OCCUPIED', statusSince: new Date() } }, { session });
    primary.combinedWith = ids; await primary.save({ session });
    await C.audit({ businessId, branchId: primary.branchId, userId: user._id, action: 'restaurant.table.combine', entityType: 'RestaurantTable', entityId: primary._id, newValue: { combined: ids } }, session);
    return RestaurantTable.findById(primary._id).session(session);
  });
}
async function split(businessId, user, id) {
  return C.inTx(async (session) => {
    const primary = await RestaurantTable.findOne({ _id: id, businessId }).session(session);
    if (!primary?.combinedWith?.length) throw ApiError.badRequest('This table is not combined', 'NOT_COMBINED');
    C.assertBranchAccess(user, primary.branchId);
    await RestaurantTable.updateMany({ _id: { $in: primary.combinedWith } }, { $set: { combinedInto: null, status: 'AVAILABLE', statusSince: new Date() } }, { session });
    primary.combinedWith = []; await primary.save({ session });
    await C.audit({ businessId, branchId: primary.branchId, userId: user._id, action: 'restaurant.table.split', entityType: 'RestaurantTable', entityId: primary._id }, session);
    return primary;
  });
}

module.exports = { createTable, updateTable, floor, claimTable, releaseTable, setStatus, assignWaiter, combine, split };
