/** Kitchen order tickets (KOT) and the kitchen display queue. The ORDER ITEM is the source of truth; tickets mirror it for the screens/printers. */
const mongoose = require('mongoose');
const KitchenTicket = require('../../models/KitchenTicket');
const RestaurantOrder = require('../../models/RestaurantOrder');
const ApiError = require('../../utils/ApiError');
const { nextSequence, pad } = require('../../models/Counter');
const { canTransition } = require('../../constants/restaurant');
const { localParts } = require('../../utils/restaurantTime');
const consumption = require('./consumption.service');
const C = require('./common');

const mods = (i) => (i.modifiers || []).map((m) => (m.removal ? `NO ${m.name.replace(/^no /i, '')}` : m.quantity > 1 ? `${m.name} x${m.quantity}` : m.name)).join(', ');
const ticketItem = (i, extra = {}) => ({ orderItemId: i._id, name: i.name, variantName: i.variantName, quantity: i.quantity, modifiersText: mods(i), notes: i.notes, allergyNotes: i.allergyNotes, allergens: i.allergens, course: i.course, seatNumber: i.seatNumber, isComp: i.isComplimentary, parentItemId: i.parentItemId, status: i.status, prepMinutes: i.prepMinutes, ...extra });

/** Creates one ticket per station for the given items and links the items to them. type: NEW | ADDITION | FIRE | AMENDMENT */
async function createTickets(order, items, { type = 'NEW', ctx, session, notes, silent = false }) {
  if (!items.length) return [];
  const stations = await C.ensureStations(order.businessId, order.branchId, session);
  const groups = new Map();
  for (const i of items) { const k = String(i.stationId || (await C.stationFor(order.businessId, order.branchId, i.stationCode, session, stations))._id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const ymd = localParts(new Date(), ctx.timeZone).ymd;
  const out = [];
  for (const [stationId, list] of groups) {
    const st = stations.find((s) => String(s._id) === stationId);
    const seq = await nextSequence(order.businessId, `kot:${order.branchId}:${ymd}`, session);
    const allergy = list.some((i) => i.allergyNotes || (i.allergens || []).length);
    const [t] = await KitchenTicket.create([{
      businessId: order.businessId, branchId: order.branchId, orderId: order._id, orderNumber: order.orderNumber, ticketNumber: `K${ymd.slice(4)}-${pad(seq, 4)}`,
      stationId: st?._id, stationName: st?.name, stationCode: st?.code, tableName: order.tableName, waiterName: order.waiterName, orderType: order.orderType, guestCount: order.guestCount, pickupNumber: order.pickupNumber,
      type, priority: order.priority, allergyAlert: allergy, notes, items: list.map((i) => ticketItem(i)),
    }], { session });
    for (const i of list) i.ticketId = t._id;
    out.push(t);
  }
  if (type !== 'AMENDMENT' && !silent) await require('./print.service').enqueueKot(order, out, { session, tz: ctx.timeZone, ctx });
  return out;
}

/** Amendment ticket: the kitchen sees what changed (cancelled / note changed) instead of a silently edited original. */
async function amend(order, changes, { ctx, session, reason }) {
  const t = await createTickets(order, [], { ctx, session });
  const byStation = new Map();
  for (const c of changes) { const k = String(c.item.stationId); if (!byStation.has(k)) byStation.set(k, []); byStation.get(k).push(c); }
  const stations = await C.ensureStations(order.businessId, order.branchId, session);
  const ymd = localParts(new Date(), ctx.timeZone).ymd; const out = [];
  for (const [stationId, list] of byStation) {
    const st = stations.find((s) => String(s._id) === stationId);
    const seq = await nextSequence(order.businessId, `kot:${order.branchId}:${ymd}`, session);
    const [tk] = await KitchenTicket.create([{
      businessId: order.businessId, branchId: order.branchId, orderId: order._id, orderNumber: order.orderNumber, ticketNumber: `K${ymd.slice(4)}-${pad(seq, 4)}`,
      stationId: st?._id, stationName: st?.name, stationCode: st?.code, tableName: order.tableName, waiterName: order.waiterName, orderType: order.orderType, type: 'AMENDMENT', priority: 'URGENT', notes: reason,
      items: list.map((c) => ticketItem(c.item, { cancelled: c.cancelled, cancelReason: c.cancelled ? reason : undefined, status: c.cancelled ? 'CANCELLED' : c.item.status })),
    }], { session });
    out.push(tk);
  }
  // mark the matching lines on the ORIGINAL tickets so a screen that still shows them clearly flags cancellations
  for (const c of changes) if (c.cancelled && c.item.ticketId) await KitchenTicket.updateOne({ _id: c.item.ticketId, 'items.orderItemId': c.item._id }, { $set: { 'items.$.cancelled': true, 'items.$.status': 'CANCELLED', 'items.$.cancelReason': reason } }, { session });
  return out;
}

function deriveStatus(t) {
  const live = t.items.filter((i) => !i.cancelled && i.status !== 'CANCELLED');
  if (!live.length) return 'CANCELLED';
  if (live.every((i) => ['READY', 'SERVED'].includes(i.status))) return live.every((i) => i.status === 'SERVED') ? 'COMPLETED' : 'READY';
  if (live.some((i) => ['PREPARING', 'READY', 'SERVED'].includes(i.status))) return 'PREPARING';
  if (live.some((i) => i.status === 'ACCEPTED')) return 'ACCEPTED';
  return 'NEW';
}

/** Updates the ticket mirror for one item and recomputes the ticket status. */
async function syncTicket(order, item, session) {
  if (!item.ticketId) return null;
  const t = await KitchenTicket.findOne({ _id: item.ticketId }).session(session); if (!t) return null;
  const row = t.items.find((x) => String(x.orderItemId) === String(item._id)); if (!row) return t;
  row.status = item.status; row.acceptedAt = item.acceptedAt; row.preparingAt = item.preparingAt; row.readyAt = item.readyAt;
  const was = t.status; t.status = deriveStatus(t);
  const now = new Date();
  if (t.status !== was) { if (t.status === 'ACCEPTED') t.acceptedAt = now; if (t.status === 'PREPARING') { t.preparingAt = t.preparingAt || now; t.acceptedAt = t.acceptedAt || now; } if (t.status === 'READY') t.readyAt = now; if (t.status === 'COMPLETED') { t.readyAt = t.readyAt || now; t.completedAt = now; } }
  await t.save({ session });
  return t;
}

/**
 * Kitchen / waiter moves one item along PENDING -> ACCEPTED -> PREPARING -> READY -> SERVED.
 * Stock depletion for ON_READY happens here, in the same transaction.
 */
async function setItemStatus(businessId, user, orderId, itemId, status, { frontDesk = false } = {}) {
  const result = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, orderId, session);
    C.assertBranchAccess(user, order.branchId);
    const item = order.items.id(itemId); if (!item) throw ApiError.notFound('Item not found', 'ITEM_NOT_FOUND');
    if (status === 'SERVED') { if (!C.can(user, 'restaurant.orders.create') && !C.can(user, 'restaurant.kitchen.update')) throw ApiError.forbidden('Not allowed', 'PERMISSION_DENIED'); if (C.can(user, 'restaurant.orders.create') && !C.can(user, 'restaurant.kitchen.update')) C.assertOrderAccess(user, order, { write: true }); }
    else if (!C.can(user, 'restaurant.kitchen.update') && !(frontDesk && !ctx.ops.screen)) throw ApiError.forbidden('Missing permission: restaurant.kitchen.update', 'PERMISSION_DENIED');
    if (item.status === status) return { order, item, tickets: [], changed: false };      // replays are harmless
    if (!canTransition(item.status, status)) throw ApiError.conflict(`Item is ${item.status}; it cannot go to ${status}`, 'INVALID_ITEM_TRANSITION');
    const now = new Date();
    const stamp = { ACCEPTED: 'acceptedAt', PREPARING: 'preparingAt', READY: 'readyAt', SERVED: 'servedAt' }[status];
    if (['PREPARING', 'READY'].includes(status)) item.acceptedAt = item.acceptedAt || now;
    if (status === 'READY') item.preparingAt = item.preparingAt || now;
    item.status = status; item[stamp] = now;
    // combo children follow the parent's lifecycle for display; they are their own kitchen items otherwise
    const tickets = [await syncTicket(order, item, session)];
    if (status === 'READY') await consumption.depleteDue(order, 'ON_READY', { ctx, userId: user._id, session, onlyIds: [item._id] });
    C.touch(order, user._id, `item.${status.toLowerCase()}`, item.name, { itemId: item._id });
    await order.save({ session });
    return { order, item, tickets, changed: true, ctx };
  });
  if (result.changed && result.item.status === 'READY') notifyReady(result.order, result.item);
  if (result.changed && result.item.status === 'SERVED') {
    await require('../hospitality/folio.service').autoPostRoomOrder(businessId, orderId);   // room-service orders are charged to the room when fully served
    await require('./bill.service').tryCloseOrder(businessId, orderId, user);
  }
  return result;
}

function notifyReady(order, item) {
  const open = order.items.filter((i) => !['CANCELLED', 'SERVED', 'DRAFT'].includes(i.status) && !i.parentItemId);
  const all = open.length > 0 && open.every((i) => i.status === 'READY');
  C.notifyUser(order.businessId, order.waiterId, {
    type: all ? 'KITCHEN_ORDER_READY' : 'KITCHEN_ITEM_READY', branchId: order.branchId, entityType: 'RestaurantOrder', entityId: order._id,
    title: all ? `${order.tableName || order.pickupNumber || order.orderNumber}: order ready` : `${order.tableName || order.orderNumber}: ${item.name} ready`,
    message: all ? `Everything for ${order.tableName || order.orderNumber} is ready to serve.` : `${item.quantity} x ${item.name} is ready for ${order.tableName || order.orderNumber}.`, data: { orderId: order._id, itemId: item._id },
  });
}

/** Bump: mark every open item on a ticket (default READY). */
async function bumpTicket(businessId, user, ticketId, status = 'READY') {
  const t = await KitchenTicket.findOne({ _id: ticketId, businessId }); if (!t) throw ApiError.notFound('Ticket not found', 'TICKET_NOT_FOUND');
  C.assertBranchAccess(user, t.branchId);
  const path = { ACCEPTED: ['PENDING'], PREPARING: ['PENDING', 'ACCEPTED'], READY: ['PENDING', 'ACCEPTED', 'PREPARING'] }[status];
  if (!path) throw ApiError.badRequest('Bump to ACCEPTED, PREPARING or READY', 'INVALID_STATUS');
  for (const row of t.items.filter((r) => !r.cancelled && path.includes(r.status))) await setItemStatus(businessId, user, t.orderId, row.orderItemId, status);
  return KitchenTicket.findById(t._id);
}

async function expoConfirm(businessId, user, ticketId) {
  const t = await KitchenTicket.findOne({ _id: ticketId, businessId }); if (!t) throw ApiError.notFound('Ticket not found', 'TICKET_NOT_FOUND');
  C.assertBranchAccess(user, t.branchId);
  const pending = t.items.filter((i) => !i.cancelled && !['READY', 'SERVED'].includes(i.status));
  if (pending.length) throw ApiError.conflict(`${pending.length} item(s) are not ready yet`, 'ITEMS_NOT_READY');
  t.expoConfirmedAt = new Date(); t.expoConfirmedBy = user._id; await t.save(); return t;
}

async function setPriority(businessId, user, ticketId, priority) {
  const t = await KitchenTicket.findOne({ _id: ticketId, businessId }); if (!t) throw ApiError.notFound('Ticket not found', 'TICKET_NOT_FOUND');
  C.assertBranchAccess(user, t.branchId); t.priority = priority; await t.save();
  await RestaurantOrder.updateOne({ _id: t.orderId, businessId }, { $set: { priority } }); return t;
}

async function reprint(businessId, user, ticketId, { reason }) {
  const t = await KitchenTicket.findOne({ _id: ticketId, businessId }); if (!t) throw ApiError.notFound('Ticket not found', 'TICKET_NOT_FOUND');
  C.assertBranchAccess(user, t.branchId);
  t.printCount += 1; t.reprints.push({ at: new Date(), by: user._id, reason }); await t.save();
  await C.audit({ businessId, branchId: t.branchId, userId: user._id, action: 'restaurant.kot.reprint', entityType: 'KitchenTicket', entityId: t._id, newValue: { reason } });
  return t;
}

/** The kitchen screen's queue. A restarted screen calls this and gets the full active picture back. */
async function queue(businessId, user, { branchId, stationId, status, includeCompleted = false, sinceMinutes = 120 }) {
  C.assertBranchAccess(user, branchId);
  const ctx = await C.getContext(businessId);
  const f = { businessId, branchId };
  if (stationId) f.stationId = stationId;
  f.status = status ? status : { $in: includeCompleted ? ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'] : ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] };
  if (!includeCompleted && !status) f.$nor = [{ status: 'READY', expoConfirmedAt: { $ne: null } }];      // "Handed to waiter" takes the ticket off the board
  if (includeCompleted) f.receivedAt = { $gte: new Date(Date.now() - sinceMinutes * 60000) };
  const tickets = await KitchenTicket.find(f).sort({ priority: -1, receivedAt: 1 }).limit(300);
  const now = Date.now(); const lim = ctx.settings.kitchenDelayMinutes;
  return tickets.map((t) => {
    const age = Math.floor((now - t.receivedAt) / 60000);
    const maxPrep = Math.max(0, ...t.items.filter((i) => !i.cancelled).map((i) => i.prepMinutes || 0));
    return { ...t.toJSON(), ageMinutes: age, overdue: ['NEW', 'ACCEPTED', 'PREPARING'].includes(t.status) && age > Math.max(lim, maxPrep), items: t.items.map((i) => ({ ...(i.toJSON ? i.toJSON() : i), ageMinutes: Math.floor((now - t.receivedAt) / 60000) })) };
  });
}

/** Average preparation time per station and per dish (item PREPARING/ACCEPTED -> READY) plus delays and cancellations. */
async function stats(businessId, user, { branchId, from, to }) {
  const scope = C.branchScope(user, branchId);
  const end = to ? new Date(to) : new Date(); const start = from ? new Date(from) : new Date(end.getTime() - 7 * 86400000);
  const base = { businessId: C.oid(businessId), ...C.branchFilter(scope), receivedAt: { $gte: start, $lte: end } };
  const [byStation, byItem, counts] = await Promise.all([
    KitchenTicket.aggregate([{ $match: { ...base, readyAt: { $ne: null } } }, { $group: { _id: { id: '$stationId', name: '$stationName' }, tickets: { $sum: 1 }, avgMinutes: { $avg: { $divide: [{ $subtract: ['$readyAt', '$receivedAt'] }, 60000] } } } }, { $sort: { avgMinutes: -1 } }]),
    KitchenTicket.aggregate([{ $match: base }, { $unwind: '$items' }, { $match: { 'items.readyAt': { $ne: null }, 'items.cancelled': false } }, { $group: { _id: '$items.name', count: { $sum: '$items.quantity' }, avgMinutes: { $avg: { $divide: [{ $subtract: ['$items.readyAt', '$receivedAt'] }, 60000] } } } }, { $sort: { count: -1 } }, { $limit: 100 }]),
    KitchenTicket.aggregate([{ $match: base }, { $group: { _id: null, tickets: { $sum: 1 }, delayed: { $sum: { $cond: [{ $ne: ['$delayAlertedAt', null] }, 1, 0] } }, cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } }, amendments: { $sum: { $cond: [{ $eq: ['$type', 'AMENDMENT'] }, 1, 0] } }, reprints: { $sum: '$printCount' } } }]),
  ]);
  const r = (n) => Math.round(n * 10) / 10;
  return { from: start, to: end, ...(counts[0] ? { tickets: counts[0].tickets, delayed: counts[0].delayed, cancelled: counts[0].cancelled, amendments: counts[0].amendments, reprints: counts[0].reprints } : { tickets: 0, delayed: 0, cancelled: 0, amendments: 0, reprints: 0 }), byStation: byStation.map((s) => ({ stationId: s._id.id, station: s._id.name, tickets: s.tickets, avgMinutes: r(s.avgMinutes) })), byItem: byItem.map((i) => ({ item: i._id, count: i.count, avgMinutes: r(i.avgMinutes) })) };
}

/** Job: alert waiters and managers about tickets older than the delay limit. Once per ticket. */
async function delayAlerts() {
  const cfg = require('../../models/RestaurantSettings');
  const all = await cfg.find({}).select('businessId kitchenDelayMinutes');
  let n = 0;
  for (const s of all) {
    const cutoff = new Date(Date.now() - s.kitchenDelayMinutes * 60000);
    const late = await KitchenTicket.find({ businessId: s.businessId, status: { $in: ['NEW', 'ACCEPTED', 'PREPARING'] }, receivedAt: { $lte: cutoff }, delayAlertedAt: null }).limit(100);
    for (const t of late) {
      const got = await KitchenTicket.updateOne({ _id: t._id, delayAlertedAt: null }, { $set: { delayAlertedAt: new Date() } });
      if (!got.modifiedCount) continue; n += 1;
      const o = await RestaurantOrder.findById(t.orderId).select('waiterId'); const mins = Math.floor((Date.now() - t.receivedAt) / 60000);
      const payload = { type: 'KITCHEN_DELAY', title: `Delayed: ${t.tableName || t.orderNumber} (${t.stationName})`, message: `Ticket ${t.ticketNumber} has waited ${mins} minutes at ${t.stationName}.`, branchId: t.branchId, entityType: 'KitchenTicket', entityId: t._id };
      C.notifyUser(t.businessId, o?.waiterId, payload); C.notifyRoles(t.businessId, t.branchId, [...C.FLOOR_LEAD_ROLES, 'CHEF', 'EXPEDITOR'], payload);
    }
  }
  return n;
}

module.exports = { createTickets, amend, syncTicket, setItemStatus, bumpTicket, expoConfirm, setPriority, reprint, queue, stats, delayAlerts, notifyReady, deriveStatus };
