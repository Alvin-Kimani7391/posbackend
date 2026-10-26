'use strict';
/**
 * OFFLINE LAYER for restaurant + accommodation (room service) tills.
 *
 *  snapshot() - everything a device must cache to keep working with no internet: menu + prices + modifiers (per order type),
 *               ingredients + stock, suppliers, tables/areas, kitchen stations + queue, settings, staff roster, open orders,
 *               open bills, reservations, in-house guests / rooms (room charges), payment options, business + receipt details.
 *  replay()   - applies the operations the device queued while offline, IN ORDER, each one idempotent (OfflineOp ledger),
 *               reusing the SAME services the online app uses, so stock depletion, tax, service charge, receipts, eTIMS,
 *               tips and folios behave identically. Business conflicts are RECORDED and reported, never silently overwritten.
 *
 * M-PESA STK push needs the internet and is not replayed. An M-PESA payment taken offline is replayed as a mobile-money
 * payment carrying the customer's M-PESA code: stored UNVERIFIED so it shows in the existing "unverified payments" screen.
 */
const OfflineOp = require('../../models/OfflineOp');
const Supplier = require('../../models/Supplier');
const Reservation = require('../../models/Reservation');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantBill = require('../../models/RestaurantBill');
const User = require('../../models/User');
const Stay = require('../../models/Stay');
const Room = require('../../models/Room');
const ApiError = require('../../utils/ApiError');
const C = require('./common');
const R = require('../../constants/restaurant');
const v = require('../../validators/restaurant-offline.validator');
const menu = require('./menu.service');
const settingsSvc = require('./settings.service');
const tables = require('./table.service');
const ing = require('./ingredient.service');
const orders = require('./order.service');
const bills = require('./bill.service');
const kitchen = require('./kitchen.service');

const SKEW_WARN_MS = 5 * 60 * 1000;
const CONFLICT_CODES = new Set(['ORDER_VERSION_CONFLICT', 'TABLE_OCCUPIED', 'ORDER_NOT_OPEN', 'BILL_NOT_PAYABLE', 'BILL_SETTLED', 'INVALID_ITEM_TRANSITION', 'TABLE_RESERVED', 'OVERPAYMENT', 'INSUFFICIENT_STOCK', 'MENU_ITEM_UNAVAILABLE', 'DEPENDENCY_FAILED', 'ORDER_NOT_FOUND', 'ITEM_NOT_FOUND', 'BILL_NOT_FOUND', 'SHIFT_REQUIRED']);

const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback; } };

// ------------------------------------------------------------------ snapshot
async function snapshot(businessId, user, { branchId, since } = {}) {
  C.assertBranchAccess(user, branchId);
  const ctx = await C.getContext(businessId);
  const can = (p) => C.can(user, p);
  const allIng = async () => { const out = []; for (let page = 1; page <= 10; page += 1) { const r = await ing.listIngredients(businessId, { page, limit: 200 }); out.push(...r.items); if (page >= r.pages) break; } return out; };
  const types = ctx.settings.serviceMode === 'ACCOMMODATION' ? ['ROOM_SERVICE', 'COUNTER', 'TAKEAWAY'] : R.ORDER_TYPES.filter((t) => ctx.settings.serviceMode !== 'RESTAURANT' || t !== 'ROOM_SERVICE');
  const [menus, groups, ingredients, stock, suppliers, floor, areas, stations, queue, openOrders, openBills, payCtx, reservations, staff, stays, rooms] = await Promise.all([
    can('restaurant.menu.view') ? Promise.all(types.map(async (t) => [t, await safe(() => menu.getMenu(businessId, user, { branchId, orderType: t }), null)])) : [],
    safe(() => menu.listGroups(businessId), []),
    ctx.features.recipes || can('restaurant.ingredients.view') ? safe(allIng, []) : [],
    ctx.features.recipes ? safe(async () => (await ing.listStock(businessId, user, { branchId, limit: 200 })), null) : null,
    safe(() => Supplier.find({ businessId, status: { $ne: 'archived' } }).select('name phone email').limit(500).lean(), []),
    ctx.features.tables ? safe(() => tables.floor(businessId, user, { branchId }), []) : [],
    ctx.features.tables ? safe(() => settingsSvc.listAreas(businessId, branchId), []) : [],
    safe(() => settingsSvc.listStations(businessId, branchId), []),
    safe(() => kitchen.queue(businessId, user, { branchId }), []),
    safe(async () => (await orders.listOrders(businessId, user, { branchId, status: 'OPEN', limit: 200 })).items, []),
    safe(async () => (await bills.listBills(businessId, user, { branchId, limit: 200 })).items, []),
    safe(() => bills.payContext(businessId, user, branchId), null),
    ctx.features.reservations ? safe(() => Reservation.find({ businessId, branchId, status: { $in: ['BOOKED', 'CONFIRMED', 'ARRIVED', 'SEATED'] }, endsAt: { $gt: new Date() } }).sort({ startsAt: 1 }).limit(300).lean(), []) : [],
    safe(() => User.find({ businessId, status: 'active', $or: [{ branchIds: branchId }, { branchIds: { $size: 0 } }] }).select('name role').lean(), []),
    ctx.features.accommodation ? safe(() => Stay.find({ businessId, branchId, status: 'CHECKED_IN' }).select('stayNumber roomId guest status expectedCheckOut').limit(500).lean(), []) : [],
    ctx.features.accommodation ? safe(() => Room.find({ businessId, branchId }).select('number status roomTypeId').limit(1000).lean(), []) : [],
  ]);
  return {
    serverTime: new Date(), since: since || null, branchId, serviceMode: ctx.settings.serviceMode, timeZone: ctx.timeZone, taxInclusive: ctx.taxInclusive, defaultTaxRate: ctx.defaultTaxRate,
    features: ctx.features, plan: ctx.ops, settings: ctx.settings,
    business: { id: ctx.business._id, name: ctx.business.name, phone: ctx.business.phone, address: ctx.business.address, currency: ctx.business.currency, vatRegistered: ctx.business.vatRegistered, kraPin: ctx.business.kraPin || ctx.business.taxPin },
    user: { id: user._id, name: user.name, role: user.role, branchIds: user.branchIds },
    menus: Object.fromEntries(menus.filter(([, m]) => m)), modifierGroups: groups, ingredients, stock, suppliers, floor, areas, stations, kitchenQueue: queue,
    openOrders, openBills, payContext: payCtx, reservations, staff, inHouseStays: stays, rooms,
    offlineCapabilities: { ops: v.opSchema.options.map((o) => o.shape.type.value), mpesaStk: false, mpesaCodeOffline: true, maxOpsPerReplay: 200 },
  };
}

// ------------------------------------------------------------------ replay
class Ctx {
  constructor(businessId, user, deviceId) { this.businessId = businessId; this.user = user; this.deviceId = deviceId; this.byOp = new Map(); }
}
const dep = (m) => Object.assign(ApiError.conflict(m, 'DEPENDENCY_FAILED'), { dependency: true });

async function ledgerOf(c, opId) {
  if (c.byOp.has(opId)) return c.byOp.get(opId);
  const row = await OfflineOp.findOne({ businessId: c.businessId, deviceId: c.deviceId, clientOpId: opId }).lean();
  if (row) c.byOp.set(opId, row);
  return row;
}
async function resolveOrder(c, ref) {
  if (ref.orderId) return ref.orderId;
  if (ref.opId) {
    const row = await ledgerOf(c, ref.opId);
    if (!row) throw dep('The step that opened this order was never received');
    if (row.status !== 'APPLIED') throw dep('The step that opened this order did not go through');
    return row.result.orderId;
  }
  const o = await RestaurantOrder.findOne({ businessId: c.businessId, deviceId: c.deviceId, clientRef: ref.clientRef }).select('_id');
  if (!o) throw ApiError.notFound('Order for this operation was not found', 'ORDER_NOT_FOUND');
  return o._id;
}
async function resolveBill(c, ref) {
  if (ref.billId) return ref.billId;
  if (ref.opId) {
    const row = await ledgerOf(c, ref.opId);
    if (!row) throw dep('The step that created this bill was never received');
    if (row.status !== 'APPLIED') throw dep('The step that created this bill did not go through');
    return row.result.billId;
  }
  const orderId = await resolveOrder(c, ref.orderRef);
  const b = await RestaurantBill.findOne({ orderId, status: { $ne: 'VOID' } }).sort({ createdAt: -1 }).select('_id');
  if (!b) throw ApiError.notFound('No bill found for that order', 'BILL_NOT_FOUND');
  return b._id;
}
async function resolveItem(order, ref) {
  const it = ref.itemId ? order.items.id(ref.itemId) : order.items.find((x) => x.clientItemId === ref.clientItemId);
  if (!it) throw ApiError.notFound('Item not found on the order', 'ITEM_NOT_FOUND');
  return it._id;
}
const loadOrder = (c, id) => RestaurantOrder.findOne({ _id: id, businessId: c.businessId });
const orderOut = (o) => ({ orderId: o._id, orderNumber: o.orderNumber, version: o.version, status: o.status, billStatus: o.billStatus, items: o.items.filter((i) => i.clientItemId).map((i) => ({ clientItemId: i.clientItemId, itemId: i._id })) });
const pay2 = (p) => ({ method: p.method === 'MPESA' ? 'MOBILE_MONEY' : p.method, amount: p.amountCents, tendered: p.tenderedCents, reference: p.reference, network: p.method === 'MPESA' ? 'MPESA' : p.network, payerPhone: p.payerPhone, reservationId: p.reservationId, stayId: p.stayId });

const HANDLERS = {
  async openShift(c, o) { const r = await bills.openShift(c.businessId, c.user, { branchId: o.payload.branchId, registerId: o.payload.registerId, openingCash: o.payload.openingCashCents }); return { shiftId: r?._id || r?.shift?._id }; },
  async createOrder(c, o) { const r = await orders.createOrder(c.businessId, c.user, { ...o.payload, deviceId: c.deviceId, clientRef: o.payload.clientRef || o.clientOpId }); return orderOut(r.order); },
  async addItems(c, o) { const id = await resolveOrder(c, o.orderRef); const r = await orders.addItems(c.businessId, c.user, id, { items: o.payload.items, sendNow: o.payload.sendNow, expectedVersion: undefined }); return orderOut(r.order); },
  async sendOrder(c, o) { const id = await resolveOrder(c, o.orderRef); const r = await orders.sendOrder(c.businessId, c.user, id, {}); return orderOut(r.order); },
  async itemStatus(c, o) {
    const id = await resolveOrder(c, o.orderRef); const order = await loadOrder(c, id); if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
    for (const ref of o.itemRefs) await kitchen.setItemStatus(c.businessId, c.user, id, await resolveItem(order, ref), o.payload.status, { frontDesk: true });
    return orderOut(await loadOrder(c, id));
  },
  async serve(c, o) {
    const id = await resolveOrder(c, o.orderRef); const order = await loadOrder(c, id); if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
    const itemIds = []; for (const ref of o.payload.itemRefs || []) itemIds.push(await resolveItem(order, ref));
    const r = await orders.serveItems(c.businessId, c.user, id, { itemIds: itemIds.length ? itemIds : undefined, allReady: o.payload.allReady });
    return orderOut(r.order || r);
  },
  async cancelItem(c, o) { const id = await resolveOrder(c, o.orderRef); const order = await loadOrder(c, id); if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND'); const r = await orders.cancelItem(c.businessId, c.user, id, await resolveItem(order, o.itemRef), { ...(o.payload || {}), expectedVersion: undefined }); return orderOut(r.order || r); },
  async cancelOrder(c, o) { const id = await resolveOrder(c, o.orderRef); const r = await orders.cancelOrder(c.businessId, c.user, id, o.payload); return orderOut(r.order || r); },
  async generateBill(c, o) { const id = await resolveOrder(c, o.orderRef); const b = await bills.generateBill(c.businessId, c.user, id, o.payload || {}); return { billId: b._id, billNumber: b.billNumber, orderId: id, total: b.total, balance: b.balance }; },
  async pay(c, o) {
    const id = await resolveBill(c, o.billRef);
    const r = await bills.pay(c.businessId, c.user, id, { customerId: o.payload.customerId, payments: o.payload.payments.map(pay2) });
    return { billId: r.bill._id, billNumber: r.bill.billNumber, status: r.bill.status, balance: r.bill.balance, saleId: r.sale?._id, receiptNumber: r.sale?.receiptNumber, receiptId: r.receipt?._id, change: r.change, unverifiedMobileMoney: o.payload.payments.some((p) => p.method === 'MPESA') };
  },
  async addTip(c, o) { const id = await resolveBill(c, o.billRef); const t = await bills.addTip(c.businessId, c.user, id, { amount: o.payload.amountCents, method: o.payload.method, reference: o.payload.reference, waiterId: o.payload.waiterId }); return { billId: id, tipId: t?._id || t?.tip?._id }; },
  async receiveStock(c, o) { const p = o.payload; const r = await ing.receivePurchase(c.businessId, p.branchId, c.user, { supplierId: p.supplierId, invoiceNumber: p.invoiceNumber, amountPaid: p.amountPaidCents || 0, notes: p.notes, lines: p.lines }); return { purchaseId: r?._id || r?.purchase?._id, purchaseNumber: r?.purchaseNumber || r?.purchase?.purchaseNumber }; },
  async waste(c, o) { const r = await ing.recordWaste(c.businessId, o.payload.branchId, c.user, o.payload); return { wasteId: r?._id || r?.waste?._id }; },
  async adjustStock(c, o) { await ing.adjustStock(c.businessId, o.payload.branchId, c.user, o.payload); return { ok: true }; },
};

const branchOfOp = (o) => o.payload?.branchId;

async function applyOne(c, raw, deviceTime) {
  const clientOpId = raw && typeof raw.clientOpId === 'string' ? raw.clientOpId : undefined;
  const parsed = v.opSchema.safeParse(raw);
  if (!parsed.success) return { clientOpId, ok: false, status: 'REJECTED', code: 'VALIDATION_FAILED', message: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const o = parsed.data;
  const filter = { businessId: c.businessId, deviceId: c.deviceId, clientOpId: o.clientOpId };
  const existing = await OfflineOp.findOne(filter);
  if (existing && existing.status !== 'PENDING') { c.byOp.set(o.clientOpId, existing.toObject()); return { clientOpId: o.clientOpId, ok: existing.status === 'APPLIED', status: existing.status, code: existing.code, message: existing.message, result: existing.result, replayed: true }; }
  const skewMs = deviceTime ? Date.now() - new Date(deviceTime).getTime() : undefined;
  let row = existing;
  if (!row) {
    try { row = await OfflineOp.create({ ...filter, branchId: branchOfOp(o), seq: o.seq, type: o.type, userId: c.user._id, occurredAt: o.occurredAt, skewMs, payload: o }); }
    catch (e) { if (e.code === 11000) return { clientOpId: o.clientOpId, ok: false, status: 'PENDING', code: 'DUPLICATE_IN_FLIGHT', message: 'This step is already being processed' }; throw e; }
  }
  try {
    const result = await HANDLERS[o.type](c, o);
    row.status = 'APPLIED'; row.result = result; row.syncedAt = new Date(); row.code = undefined; row.message = undefined; await row.save();
    c.byOp.set(o.clientOpId, row.toObject());
    return { clientOpId: o.clientOpId, ok: true, status: 'APPLIED', result };
  } catch (e0) {
    const e = e0;
    const conflict = CONFLICT_CODES.has(e.code) || e.dependency || (e.statusCode && e.statusCode < 500);
    row.status = conflict ? 'CONFLICT' : 'PENDING'; row.code = e.code || 'ERROR'; row.message = e.message; row.syncedAt = new Date();
    await row.save().catch(() => {}); c.byOp.set(o.clientOpId, row.toObject());
    if (conflict) C.notifyManagement(c.businessId, { type: 'OFFLINE_CONFLICT', title: 'Offline sale needs review', message: `${o.type}: ${e.message}`, branchId: row.branchId, entityType: 'OfflineOp', entityId: row._id, severity: 'warning' });
    // A server fault (not a business rule) stays PENDING so the device keeps it queued and retries the same clientOpId.
    return { clientOpId: o.clientOpId, ok: false, status: conflict ? 'CONFLICT' : 'RETRY', code: e.code || 'ERROR', message: e.message, retry: !conflict };
  }
}

async function replay(businessId, user, { deviceId, deviceTime, ops }) {
  const c = new Ctx(businessId, user, deviceId);
  const sorted = ops.map((raw, i) => ({ raw, i })).sort((a, b) => (Number(a.raw?.seq ?? Infinity) - Number(b.raw?.seq ?? Infinity)) || (a.i - b.i)).map((x) => x.raw);
  const results = []; let stopped = null;
  for (const raw of sorted) {
    if (stopped) { results.push({ clientOpId: raw?.clientOpId, ok: false, status: 'RETRY', code: 'SERVER_BUSY', message: 'Not processed yet; send again', retry: true }); continue; }
    const r = await applyOne(c, raw, deviceTime).catch((e) => ({ clientOpId: raw?.clientOpId, ok: false, status: 'RETRY', code: e.code || 'ERROR', message: e.message, retry: true }));
    results.push(r);
    if (r.status === 'RETRY' && !['VALIDATION_FAILED'].includes(r.code)) stopped = r;      // keep order: do not run later steps that may depend on this one
  }
  const skewMs = deviceTime ? Date.now() - new Date(deviceTime).getTime() : 0;
  return { serverTime: new Date(), clockSkewMs: skewMs, clockWarning: Math.abs(skewMs) > SKEW_WARN_MS, applied: results.filter((r) => r.status === 'APPLIED').length, conflicts: results.filter((r) => r.status === 'CONFLICT').length, retry: results.filter((r) => r.retry).length, results };
}

async function listOps(businessId, user, { branchId, status, reviewed, page = 1, limit = 30 }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (status) f.status = status; if (reviewed !== undefined) f.reviewed = reviewed;
  const [items, total] = await Promise.all([OfflineOp.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'name').lean(), OfflineOp.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}
async function reviewOp(businessId, user, id) {
  const row = await OfflineOp.findOne({ _id: id, businessId }); if (!row) throw ApiError.notFound('Offline step not found', 'OFFLINE_OP_NOT_FOUND');
  if (row.branchId) C.assertBranchAccess(user, row.branchId);
  row.reviewed = true; row.reviewedBy = user._id; row.reviewedAt = new Date(); await row.save(); return row;
}
/** Lets a manager send a CONFLICT step back through the engine after fixing the cause (stock received, shift opened...). */
async function retryOp(businessId, user, id) {
  const row = await OfflineOp.findOne({ _id: id, businessId, status: 'CONFLICT' }); if (!row) throw ApiError.notFound('No conflicted step with that id', 'OFFLINE_OP_NOT_FOUND');
  if (row.branchId) C.assertBranchAccess(user, row.branchId);
  const author = await User.findOne({ _id: row.userId, businessId });
  row.status = 'PENDING'; await row.save();
  return replay(businessId, author || user, { deviceId: row.deviceId, ops: [row.payload] });
}

module.exports = { snapshot, replay, listOps, reviewOp, retryOp };
