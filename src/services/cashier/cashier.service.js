/**
 * Cashier dashboard service: ONE read model over everything a cashier has to collect money for, plus the cash drawer.
 *
 * It does not take payments itself. Payments are still recorded by the services that already own the rules:
 *   restaurant bills  -> services/restaurant/bill.service.js   (POST /restaurant/bills/:id/pay, M-PESA STK / till)
 *   self-service cash -> services/restaurant/selfservice.service.js (confirm cash releases the order to the kitchen)
 *   room folios       -> services/hospitality/folio.service.js (POST /accommodation/stays/:id/payments)
 * This file only reads (queue, order details, payments ledger, drawer figures) and writes drawer events and reprint jobs.
 *
 * All amounts leave this file as decimal major units (KES), like the rest of the API. Stored values are integer cents.
 * Every query is scoped by the businessId from the login (never from the request) and by the caller's branches.
 */
const mongoose = require('mongoose');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantBill = require('../../models/RestaurantBill');
const Stay = require('../../models/Stay');
const Payment = require('../../models/Payment');
const CashShift = require('../../models/CashShift');
const CashRegister = require('../../models/CashRegister');
const CashDrawerEvent = require('../../models/CashDrawerEvent');
const MpesaTransaction = require('../../models/MpesaTransaction');
const PrintJob = require('../../models/PrintJob');
const User = require('../../models/User');
const ApiError = require('../../utils/ApiError');
const { fromCents } = require('../../utils/money');
const { localParts } = require('../../utils/restaurantTime');
const C = require('../restaurant/common');
const K = require('../../constants/cashier');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const id = (v) => (v ? String(v) : null);
const mins = (t) => (t ? Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 60000)) : 0);
const LONG_WAIT_MINUTES = 30;

// ------------------------------------------------------------------ time helpers
/** The instant a local calendar day (YYYY-MM-DD) starts in a time zone. */
function zoneStart(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  let t = target;
  for (let i = 0; i < 2; i += 1) {                       // second pass settles daylight-saving offsets
    const p = localParts(new Date(t), timeZone);
    t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - target;
  }
  return new Date(t);
}
/** [from, to) for a local day. With no date it is "today" in the business time zone. */
function dayRange(timeZone, ymd) {
  const date = ymd || localParts(new Date(), timeZone).date;
  const from = zoneStart(date, timeZone);
  const next = new Date(from.getTime() + 36 * 3600000);
  const to = zoneStart(localParts(next, timeZone).date, timeZone);
  return { from, to, date };
}
async function zoneOf(businessId) {
  const ctx = await C.getContext(businessId);
  return { tz: ctx.timeZone, ctx };
}

// ------------------------------------------------------------------ channel / state rules
function channelOf(o) {
  if (o.source === 'KIOSK') return 'SELF_SERVICE';
  if (o.orderType === 'DELIVERY') return 'DELIVERY';
  if (o.orderType === 'TAKEAWAY' || o.orderType === 'PICKUP') return 'TAKEAWAY';
  if (o.orderType === 'ROOM_SERVICE') return 'ROOM_SERVICE';
  if (o.orderType === 'COUNTER' || o.orderType === 'BAR_TAB') return 'COUNTER';
  return 'DINE_IN';
}
const ORDER_SELECT = 'orderNumber pickupNumber orderType source tableName roomNumber stayId waiterName customerName customerPhone guestCount status billStatus billRequestedAt totals items.name items.quantity items.status items.parentItemId delivery selfService createdAt notes';
const BILL_SELECT = 'billNumber orderId orderNumber orderType tableName waiterName label status total paid balance createdAt issuedAt payments.kind payments.method payments.verifyStatus';
const PRIORITY = { AWAITING_CASH: 0, BILL_REQUESTED: 1, CHECKOUT_DUE: 1, PART_PAID: 2, BILLED: 3, DEPOSIT_DUE: 3, IN_HOUSE: 4, NOT_BILLED: 5, MPESA_PENDING: 6 };

function placeTitle(o, channel) {
  if (o.tableName) return `Table ${o.tableName}`;
  if (o.roomNumber) return `Room ${o.roomNumber}`;
  const who = (o.delivery && o.delivery.contactName) || o.customerName;
  if (channel === 'DELIVERY') return `Delivery${who ? ' · ' + who : ''}`;
  if (channel === 'TAKEAWAY') return o.pickupNumber ? `Pickup #${o.pickupNumber}` : 'Take away';
  if (channel === 'SELF_SERVICE') return o.pickupNumber ? `Kiosk #${o.pickupNumber}` : 'Self service';
  if (channel === 'COUNTER') return o.orderType === 'BAR_TAB' ? `Tab${who ? ' · ' + who : ''}` : 'Counter';
  return 'Order';
}

/** One restaurant row for the queue. `bill` may be null (running order nobody has billed yet). */
function restaurantRow(o, bill) {
  const channel = channelOf(o); const ss = o.selfService || {}; const d = o.delivery || {};
  const kiosk = o.source === 'KIOSK';
  const live = (o.items || []).filter((i) => !i.parentItemId && i.status !== 'CANCELLED' && i.status !== 'DRAFT');
  const notServed = live.filter((i) => i.status !== 'SERVED').length;
  const total = bill ? bill.total : (o.totals && o.totals.total) || 0;
  const paid = bill ? bill.paid || 0 : 0;
  const balance = bill ? (bill.balance != null ? bill.balance : Math.max(0, total - paid)) : total;
  let state;
  if (kiosk && ss.paymentState === 'AWAITING_CASH') state = 'AWAITING_CASH';
  else if (kiosk && ss.paymentState === 'PENDING') state = 'MPESA_PENDING';
  else if (bill && bill.status === 'PARTIAL') state = 'PART_PAID';
  else if (o.billStatus === 'REQUESTED' || (!bill && o.billRequestedAt)) state = 'BILL_REQUESTED';
  else if (bill) state = 'BILLED';
  else state = 'NOT_BILLED';
  const flags = [];
  if (o.billRequestedAt && state !== 'AWAITING_CASH') flags.push('BILL_REQUESTED');
  if (channel === 'DELIVERY' && (d.payment || 'CASH') === 'CASH') flags.push('CASH_ON_DELIVERY');
  if (channel === 'DELIVERY' && d.status === 'DELIVERED') flags.push('DELIVERED');
  if (channel === 'DELIVERY' && d.status === 'OUT_FOR_DELIVERY') flags.push('OUT_FOR_DELIVERY');
  if (notServed > 0 && !kiosk) flags.push('NOT_ALL_SERVED');
  if (bill && (bill.payments || []).some((p) => p.verifyStatus === 'PENDING')) flags.push('UNVERIFIED_PAYMENT');
  const created = bill ? bill.issuedAt || bill.createdAt : o.createdAt;
  if (mins(o.createdAt) > LONG_WAIT_MINUTES && state !== 'MPESA_PENDING') flags.push('LONG_WAIT');
  let payAction = 'BILL_PAY';
  if (kiosk) payAction = state === 'AWAITING_CASH' ? 'KIOSK_CASH' : state === 'MPESA_PENDING' ? 'NONE' : bill ? 'BILL_PAY' : 'ORDER_BILL_PAY';
  else if (!bill) payAction = 'ORDER_BILL_PAY';
  return {
    key: bill ? `bill:${bill._id}` : `order:${o._id}`, kind: bill ? 'BILL' : 'ORDER',
    billId: bill ? id(bill._id) : null, orderId: id(o._id), stayId: id(o.stayId),
    ref: bill ? bill.billNumber : o.orderNumber, billNumber: bill ? bill.billNumber : null, orderNumber: o.orderNumber, label: bill ? bill.label || null : null,
    title: placeTitle(o, channel), channel, channelLabel: K.CHANNELS[channel], source: o.source, orderType: o.orderType,
    state, payAction, kiosk,
    total: fromCents(total), paid: fromCents(paid), balance: fromCents(balance),
    createdAt: created, waitMinutes: mins(o.createdAt),
    waiterName: o.waiterName || null, customerName: (d.contactName || o.customerName) || null, customerPhone: (d.phone || o.customerPhone) || null,
    tableName: o.tableName || null, roomNumber: o.roomNumber || null, pickupNumber: o.pickupNumber || null, guestCount: o.guestCount || null,
    itemCount: live.length, itemsPreview: live.slice(0, 3).map((i) => `${i.quantity} x ${i.name}`), servedCount: live.length - notServed,
    payHint: kiosk ? ss.paymentMethod || null : channel === 'DELIVERY' ? d.payment || 'CASH' : null,
    delivery: channel === 'DELIVERY' ? { status: d.status || 'PENDING', riderName: d.riderName || null, address: d.address || null, payment: d.payment || 'CASH', online: !!d.online } : null,
    kioskExpiresAt: kiosk && ['PENDING', 'AWAITING_CASH'].includes(ss.paymentState) ? ss.expiresAt || null : null,
    flags,
  };
}

function stayRow(s) {
  const t = s.totals || {};
  const deposit = s.status === 'RESERVED';
  const balance = deposit ? Math.max(0, (s.depositRequired || 0) - (t.paid || 0)) : t.balance || 0;
  const flags = [];
  if (s.checkoutRequestedAt) flags.push('CHECKOUT_REQUESTED');
  if (s.__dueOut) flags.push('DUE_OUT_TODAY');
  if (s.__overdue) flags.push('OVERDUE');
  if ((s.payments || []).some((p) => p.verifyStatus === 'PENDING')) flags.push('UNVERIFIED_PAYMENT');
  const state = deposit ? 'DEPOSIT_DUE' : s.checkoutRequestedAt || s.__dueOut || s.__overdue ? 'CHECKOUT_DUE' : 'IN_HOUSE';
  return {
    key: `stay:${s._id}`, kind: 'STAY', billId: null, orderId: null, stayId: id(s._id),
    ref: s.stayNumber, billNumber: null, orderNumber: null, label: s.bookingCode || null,
    title: `Room ${s.roomNumber || '?'} · ${(s.guest && s.guest.name) || 'Guest'}`,
    channel: 'ACCOMMODATION', channelLabel: K.CHANNELS.ACCOMMODATION, source: s.source || null, orderType: null,
    state, payAction: 'STAY_PAY', kiosk: false,
    total: fromCents(deposit ? s.depositRequired || 0 : t.charges || 0), paid: fromCents(t.paid || 0), balance: fromCents(balance),
    createdAt: s.createdAt, waitMinutes: s.checkoutRequestedAt ? mins(s.checkoutRequestedAt) : 0,
    waiterName: null, customerName: (s.guest && s.guest.name) || null, customerPhone: (s.guest && s.guest.phone) || null,
    tableName: null, roomNumber: s.roomNumber || null, pickupNumber: null, guestCount: (s.adults || 0) + (s.children || 0) || null,
    itemCount: 0, itemsPreview: [`${s.checkInDate} → ${s.checkOutDate}`, s.roomTypeName].filter(Boolean), servedCount: 0, payHint: null, delivery: null, kioskExpiresAt: null,
    stay: { status: s.status, checkInDate: s.checkInDate, checkOutDate: s.checkOutDate, nights: s.nights, mealPlan: s.mealPlan, roomTypeName: s.roomTypeName },
    flags,
  };
}

// ------------------------------------------------------------------ the unified queue
async function buildQueue(businessId, user, { branchId, channel, search } = {}) {
  const scope = C.branchScope(user, branchId); const bf = C.branchFilter(scope);
  const { tz, ctx } = await zoneOf(businessId);
  const rows = [];

  if (channel !== 'ACCOMMODATION') {
    const bills = await RestaurantBill.find({ businessId, ...bf, status: { $in: ['OPEN', 'PARTIAL'] } }).select(BILL_SELECT).sort({ createdAt: 1 }).limit(300).lean();
    const billOrderIds = [...new Set(bills.map((b) => String(b.orderId)))];
    const billOrders = billOrderIds.length ? await RestaurantOrder.find({ businessId, _id: { $in: billOrderIds } }).select(ORDER_SELECT).lean() : [];
    const byId = new Map(billOrders.map((o) => [String(o._id), o]));
    for (const b of bills) { const o = byId.get(String(b.orderId)); if (o && o.status !== 'CANCELLED') rows.push(restaurantRow(o, b)); }

    const open = await RestaurantOrder.find({ businessId, ...bf, status: 'OPEN', billStatus: { $in: ['NONE', 'REQUESTED'] }, _id: { $nin: billOrderIds.map(oid) } }).select(ORDER_SELECT).sort({ createdAt: 1 }).limit(300).lean();
    for (const o of open) {
      const billable = (o.items || []).some((i) => !i.parentItemId && i.status !== 'CANCELLED' && i.status !== 'DRAFT');
      if (!billable || !((o.totals && o.totals.total) > 0)) continue;
      if (o.source === 'KIOSK' && !['AWAITING_CASH', 'PENDING'].includes(o.selfService && o.selfService.paymentState)) continue;
      rows.push(restaurantRow(o, null));
    }
  }

  if (!channel || channel === 'ACCOMMODATION') {
    if (ctx.features.accommodation) {
      const today = localParts(new Date(), tz).date;
      const stays = await Stay.find({
        businessId, ...bf,
        $or: [{ status: 'CHECKED_IN', 'totals.balance': { $gt: 0 } }, { status: 'RESERVED', depositRequired: { $gt: 0 }, $expr: { $lt: ['$totals.paid', '$depositRequired'] } }],
      }).select('stayNumber bookingCode status source roomNumber roomTypeName guest.name guest.phone adults children checkInDate checkOutDate nights mealPlan totals depositRequired payments.verifyStatus checkoutRequestedAt createdAt').sort({ checkOutDate: 1 }).limit(300).lean();
      for (const s of stays) { s.__dueOut = s.status === 'CHECKED_IN' && s.checkOutDate === today; s.__overdue = s.status === 'CHECKED_IN' && s.checkOutDate < today; rows.push(stayRow(s)); }
    }
  }

  let out = channel ? rows.filter((r) => r.channel === channel) : rows;
  const q = String(search || '').trim().toLowerCase();
  if (q) out = out.filter((r) => [r.ref, r.orderNumber, r.billNumber, r.title, r.customerName, r.customerPhone, r.waiterName, r.pickupNumber, r.roomNumber, r.tableName, r.label].some((v) => v && String(v).toLowerCase().includes(q)));
  out.sort((a, b) => (PRIORITY[a.state] ?? 9) - (PRIORITY[b.state] ?? 9) || new Date(a.createdAt) - new Date(b.createdAt));
  return out;
}

function summarize(rows) {
  const byChannel = {}; Object.keys(K.CHANNELS).forEach((c) => { byChannel[c] = { label: K.CHANNELS[c], count: 0, amount: 0 }; });
  let amount = 0;
  rows.forEach((r) => { const c = byChannel[r.channel]; if (c) { c.count += 1; c.amount += r.balance; } amount += r.balance; });
  Object.values(byChannel).forEach((c) => { c.amount = Math.round(c.amount * 100) / 100; });
  return { count: rows.length, amount: Math.round(amount * 100) / 100, byChannel, oldestWaitMinutes: rows.reduce((m, r) => Math.max(m, r.waitMinutes || 0), 0) };
}

async function queue(businessId, user, query = {}) {
  const rows = await buildQueue(businessId, user, query);
  const limit = Math.min(Number(query.limit) || 150, 300);
  return { rows: rows.slice(0, limit), total: rows.length, summary: summarize(rows), generatedAt: new Date() };
}

// ------------------------------------------------------------------ collections (what was actually taken)
async function collections(businessId, bf, from, to) {
  const range = { $gte: from, $lt: to };
  const grp = [{ $group: { _id: { kind: { $ifNull: ['$payments.kind', 'PAYMENT'] }, method: '$payments.method' }, amount: { $sum: '$payments.amount' }, count: { $sum: 1 } } }];
  const stage = (extra) => [{ $match: { businessId: oid(businessId), ...bf, 'payments.at': range, ...extra } }, { $unwind: '$payments' }, { $match: { 'payments.at': range } }, ...grp];
  const [b, s] = await Promise.all([RestaurantBill.aggregate(stage({})), Stay.aggregate(stage({}))]);
  const byMethod = {}; K.MONEY_METHODS.forEach((m) => { byMethod[m] = { amount: 0, count: 0 }; });
  let collected = 0; let refunds = 0; let postedToRoom = 0; let onCredit = 0; let depositsApplied = 0; let payments = 0;
  [...b, ...s].forEach((r) => {
    const { kind, method } = r._id;
    if (kind === 'REFUND') { refunds += r.amount; if (byMethod[method]) { byMethod[method].amount -= r.amount; } return; }
    if (K.MONEY_METHODS.includes(method)) { byMethod[method].amount += r.amount; byMethod[method].count += r.count; collected += r.amount; payments += r.count; }
    else if (method === 'ROOM') postedToRoom += r.amount;
    else if (method === 'CREDIT') onCredit += r.amount;
    else if (method === 'DEPOSIT') depositsApplied += r.amount;
  });
  Object.values(byMethod).forEach((m) => { m.amount = fromCents(m.amount); });
  return { byMethod, collected: fromCents(collected), refunds: fromCents(refunds), net: fromCents(collected - refunds), payments, postedToRoom: fromCents(postedToRoom), onCredit: fromCents(onCredit), depositsApplied: fromCents(depositsApplied) };
}

async function unverifiedCount(businessId, bf) {
  const stage = [{ $match: { businessId: oid(businessId), ...bf, 'payments.verifyStatus': 'PENDING' } }, { $unwind: '$payments' }, { $match: { 'payments.verifyStatus': 'PENDING' } }, { $count: 'n' }];
  const [b, s] = await Promise.all([RestaurantBill.aggregate(stage), Stay.aggregate(stage)]);
  return ((b[0] && b[0].n) || 0) + ((s[0] && s[0].n) || 0);
}

// ------------------------------------------------------------------ drawer
/** Everything the till screen needs about ONE open shift: sales by method, movements, and the cash that should be in the drawer. */
async function shiftFigures(shift) {
  const [sales, moves, cashier] = await Promise.all([
    Payment.aggregate([{ $match: { businessId: shift.businessId, shiftId: shift._id, status: 'SUCCESS' } }, { $group: { _id: '$method', amount: { $sum: '$amount' }, count: { $sum: 1 }, change: { $sum: { $ifNull: ['$changeGiven', 0] } } } }]),
    CashDrawerEvent.aggregate([{ $match: { shiftId: shift._id } }, { $group: { _id: '$type', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    shift.cashierName ? null : User.findById(shift.cashierId).select('name').lean(),
  ]);
  const m = Object.fromEntries(moves.map((x) => [x._id, x]));
  const cash = sales.find((x) => x._id === 'CASH') || { amount: 0, count: 0, change: 0 };
  const paidIn = (m.PAID_IN && m.PAID_IN.amount) || 0; const paidOut = (m.PAID_OUT && m.PAID_OUT.amount) || 0; const drops = (m.SAFE_DROP && m.SAFE_DROP.amount) || 0;
  const expected = (shift.openingCash || 0) + cash.amount + paidIn - paidOut - drops;
  return {
    shiftId: id(shift._id), branchId: id(shift.branchId), status: shift.status, openedAt: shift.openedAt, durationMinutes: mins(shift.openedAt),
    cashier: { id: id(shift.cashierId), name: shift.cashierName || (cashier && cashier.name) || '' },
    register: shift.registerId && shift.registerId.name ? { id: id(shift.registerId._id), name: shift.registerId.name, code: shift.registerId.code } : { id: id(shift.registerId) },
    currency: shift.currency || null,
    openingCash: fromCents(shift.openingCash || 0), cashSales: fromCents(cash.amount), cashSalesCount: cash.count, changeGiven: fromCents(cash.change),
    paidIn: fromCents(paidIn), paidOut: fromCents(paidOut), safeDrops: fromCents(drops), noSales: (m.NO_SALE && m.NO_SALE.count) || 0, drawerOpens: ((m.NO_SALE && m.NO_SALE.count) || 0) + ((m.CASH_SALE && m.CASH_SALE.count) || 0),
    expectedCash: fromCents(expected), expectedCashCents: expected,
    salesByMethod: Object.fromEntries(sales.map((x) => [x._id, { amount: fromCents(x.amount), count: x.count }])),
    totalSales: fromCents(sales.reduce((s, x) => s + x.amount, 0)),
  };
}

async function drawer(businessId, user, { branchId } = {}) {
  const scope = C.branchScope(user, branchId); const bf = C.branchFilter(scope);
  const lead = K.CASHIER_LEAD_ROLES.includes(user.role);
  const filter = lead ? { businessId, ...bf, status: 'OPEN' } : { businessId, cashierId: user._id, status: 'OPEN' };
  const shifts = await CashShift.find(filter).populate('registerId', 'name code').sort({ openedAt: 1 }).lean();
  const mine = shifts.find((s) => String(s.cashierId) === String(user._id)) || (lead ? await CashShift.findOne({ businessId, cashierId: user._id, status: 'OPEN' }).populate('registerId', 'name code').lean() : null);
  const all = mine && !shifts.some((s) => String(s._id) === String(mine._id)) ? [mine, ...shifts] : shifts;
  const names = new Map((await User.find({ _id: { $in: all.map((s) => s.cashierId) } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  const figures = await Promise.all(all.map((s) => shiftFigures({ ...s, cashierName: names.get(String(s.cashierId)) })));
  const ids = all.map((s) => s._id);
  const events = ids.length ? await CashDrawerEvent.find({ businessId, shiftId: { $in: ids } }).sort({ createdAt: -1 }).limit(60).lean() : [];
  const regBranch = branchId || (mine && mine.branchId) || (scope && scope[0]);
  const registers = regBranch ? await CashRegister.find({ businessId, branchId: regBranch, status: 'active' }).sort({ name: 1 }).lean() : [];
  const busy = new Set((regBranch ? await CashShift.find({ businessId, branchId: regBranch, status: 'OPEN' }).select('registerId').lean() : []).map((s) => String(s.registerId)));
  const { ctx } = await zoneOf(businessId);
  return {
    myShiftId: mine ? id(mine._id) : null, lead,
    shifts: figures,
    events: events.map((e) => ({ id: id(e._id), shiftId: id(e.shiftId), type: e.type, amount: fromCents(e.amount), reason: e.reason || '', reference: e.reference || '', by: e.byName || '', at: e.createdAt })),
    registers: registers.map((r) => ({ id: id(r._id), name: r.name, code: r.code, inUse: busy.has(String(r._id)) })),
    requireShift: !!(ctx.settings.paymentsRequireShift && ctx.business.settings && ctx.business.settings.requireShift !== false),
    currency: ctx.business.currency || 'KES',
  };
}

async function recordDrawerEvent(businessId, user, { type, amount, reason, reference, billId }) {
  if (!K.DRAWER_EVENT_TYPES.includes(type)) throw ApiError.badRequest('Unknown drawer action', 'INVALID_DRAWER_EVENT');
  const shift = await CashShift.findOne({ businessId, cashierId: user._id, status: 'OPEN' }).populate('registerId', 'name code').lean();
  if (!shift) throw ApiError.badRequest('Open your cash shift first. The drawer belongs to your shift.', 'SHIFT_REQUIRED');
  C.assertBranchAccess(user, shift.branchId);
  const money = K.DRAWER_MONEY_TYPES.includes(type);
  if (money && !(amount > 0)) throw ApiError.badRequest('Enter the amount', 'INVALID_AMOUNT');
  if ((money || type === 'NO_SALE') && !String(reason || '').trim()) throw ApiError.badRequest('Give a reason', 'REASON_REQUIRED');
  if (type === 'PAID_OUT' || type === 'SAFE_DROP') {
    const f = await shiftFigures({ ...shift, cashierName: user.name });
    if (amount > f.expectedCashCents) throw ApiError.badRequest(`There is only ${fromCents(f.expectedCashCents).toLocaleString('en-KE', { minimumFractionDigits: 2 })} in the drawer`, 'INSUFFICIENT_DRAWER_CASH');
  }
  const ev = await CashDrawerEvent.create({ businessId, branchId: shift.branchId, shiftId: shift._id, registerId: shift.registerId && shift.registerId._id, type, amount: money ? amount : 0, reason: reason ? String(reason).trim() : undefined, reference: reference || undefined, billId: billId || undefined, by: user._id, byName: user.name });
  C.audit({ businessId, branchId: shift.branchId, userId: user._id, action: `drawer.${type.toLowerCase()}`, entityType: 'CashDrawerEvent', entityId: ev._id, newValue: { type, amount: money ? amount : 0, reason, reference, register: shift.registerId && shift.registerId.name } }).catch((e) => console.error('[cashier] audit failed', e.message));
  if (type !== 'CASH_SALE' && type !== 'PAID_IN') {
    const label = { NO_SALE: 'Drawer opened without a sale', PAID_OUT: 'Cash paid out of the drawer', SAFE_DROP: 'Cash moved to the safe' }[type];
    C.notifyManagement(businessId, { type: 'CASH_DRAWER_EVENT', title: `${label} · ${user.name}`, message: `${money ? `KSh ${fromCents(amount).toLocaleString('en-KE', { minimumFractionDigits: 2 })} · ` : ''}${reason || ''}`, branchId: shift.branchId, sourceUserId: user._id, entityType: 'CashDrawerEvent', entityId: ev._id });
  }
  const figures = await shiftFigures({ ...shift, cashierName: user.name });
  return { event: { id: id(ev._id), type, amount: fromCents(ev.amount), reason: ev.reason || '', reference: ev.reference || '', by: user.name, at: ev.createdAt }, shift: figures };
}

// ------------------------------------------------------------------ overview
async function overview(businessId, user, { branchId } = {}) {
  const scope = C.branchScope(user, branchId); const bf = C.branchFilter(scope);
  const { tz, ctx } = await zoneOf(businessId);
  const { from, to, date } = dayRange(tz);
  const [rows, today, unverified, pendingStk, myShift] = await Promise.all([
    buildQueue(businessId, user, { branchId }),
    collections(businessId, bf, from, to),
    unverifiedCount(businessId, bf),
    MpesaTransaction.countDocuments({ businessId, ...bf, status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 10 * 60000) } }),
    CashShift.findOne({ businessId, cashierId: user._id, status: 'OPEN' }).populate('registerId', 'name code').lean(),
  ]);
  const shift = myShift ? await shiftFigures({ ...myShift, cashierName: user.name }) : null;
  const openShifts = K.CASHIER_LEAD_ROLES.includes(user.role) ? await CashShift.countDocuments({ businessId, ...bf, status: 'OPEN' }) : (myShift ? 1 : 0);
  return {
    date, timeZone: tz, generatedAt: new Date(), currency: ctx.business.currency || 'KES',
    awaiting: summarize(rows),
    attention: {
      kioskCashWaiting: rows.filter((r) => r.state === 'AWAITING_CASH').length,
      billRequested: rows.filter((r) => r.flags.includes('BILL_REQUESTED')).length,
      longWait: rows.filter((r) => r.flags.includes('LONG_WAIT')).length,
      checkoutsDue: rows.filter((r) => r.state === 'CHECKOUT_DUE').length,
      unverifiedPayments: unverified, mpesaInProgress: pendingStk,
      codDeliveries: rows.filter((r) => r.flags.includes('CASH_ON_DELIVERY')).length,
    },
    today, shift, openShifts,
    features: { restaurant: ctx.features.ordering, accommodation: ctx.features.accommodation },
  };
}

// ------------------------------------------------------------------ payments ledger
async function payments(businessId, user, { branchId, date, from, to, method, channel, kind, search, limit = 300 } = {}) {
  const scope = C.branchScope(user, branchId); const bf = C.branchFilter(scope);
  const { tz } = await zoneOf(businessId);
  let range;
  if (from || to) range = { $gte: from ? new Date(from) : new Date(0), $lt: to ? new Date(to) : new Date(Date.now() + 60000) };
  else { const d = dayRange(tz, date); range = { $gte: d.from, $lt: d.to }; }
  const lim = Math.min(Number(limit) || 300, 600);
  const pre = [{ $match: { businessId: oid(businessId), ...bf, 'payments.at': range } }, { $unwind: '$payments' }, { $match: { 'payments.at': range, ...(method ? { 'payments.method': method } : {}), ...(kind ? { 'payments.kind': kind } : {}) } }, { $sort: { 'payments.at': -1 } }, { $limit: lim }];
  const [bills, stays] = await Promise.all([
    channel === 'ACCOMMODATION' ? [] : RestaurantBill.aggregate([...pre, { $project: { billNumber: 1, orderNumber: 1, orderId: 1, tableName: 1, waiterName: 1, branchId: 1, receiptNumber: 1, p: '$payments' } }]),
    channel && channel !== 'ACCOMMODATION' ? [] : Stay.aggregate([...pre, { $project: { stayNumber: 1, roomNumber: 1, guestName: '$guest.name', branchId: 1, receiptNumber: 1, p: '$payments' } }]),
  ]);
  const orderIds = [...new Set(bills.map((b) => String(b.orderId)))];
  const orders = orderIds.length ? await RestaurantOrder.find({ businessId, _id: { $in: orderIds } }).select('orderType source tableName roomNumber').lean() : [];
  const oMap = new Map(orders.map((o) => [String(o._id), o]));
  const userIds = [...new Set([...bills, ...stays].map((r) => id(r.p.by)).filter(Boolean))];
  const uMap = new Map((await User.find({ _id: { $in: userIds } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  const row = (r, doc) => ({
    id: id(r.p._id), at: r.p.at, kind: r.p.kind || 'PAYMENT', method: r.p.method, amount: fromCents(r.p.amount),
    tendered: r.p.tendered != null ? fromCents(r.p.tendered) : null, change: r.p.change != null ? fromCents(r.p.change) : null,
    reference: r.p.reference || '', network: r.p.network || '', payerPhone: r.p.payerPhone || '', verifyStatus: r.p.verifyStatus || null,
    by: uMap.get(id(r.p.by)) || (r.p.by ? 'Guest / system' : ''), ...doc,
  });
  let out = [
    ...bills.map((b) => { const o = oMap.get(String(b.orderId)); const ch = o ? channelOf(o) : 'DINE_IN'; return row(b, { docType: 'BILL', docId: id(b._id), orderId: id(b.orderId), number: b.billNumber, label: o ? placeTitle({ ...o, tableName: b.tableName || o.tableName }, ch) : (b.tableName ? `Table ${b.tableName}` : b.orderNumber), orderNumber: b.orderNumber, receiptNumber: b.receiptNumber || '', channel: ch, channelLabel: K.CHANNELS[ch] }); }),
    ...stays.map((s) => row(s, { docType: 'STAY', docId: id(s._id), orderId: null, number: s.stayNumber, label: `Room ${s.roomNumber || '?'} · ${s.guestName || ''}`, orderNumber: null, receiptNumber: s.receiptNumber || '', channel: 'ACCOMMODATION', channelLabel: K.CHANNELS.ACCOMMODATION })),
  ];
  if (channel) out = out.filter((r) => r.channel === channel);
  const q = String(search || '').trim().toLowerCase();
  if (q) out = out.filter((r) => [r.number, r.label, r.reference, r.payerPhone, r.by, r.orderNumber, r.receiptNumber].some((v) => v && String(v).toLowerCase().includes(q)));
  out.sort((a, b) => new Date(b.at) - new Date(a.at));
  const sum = { byMethod: {}, collected: 0, refunds: 0, count: out.length };
  out.forEach((r) => {
    if (r.kind === 'REFUND') { sum.refunds += r.amount; if (K.MONEY_METHODS.includes(r.method)) { sum.byMethod[r.method] = sum.byMethod[r.method] || { amount: 0, count: 0 }; sum.byMethod[r.method].amount -= r.amount; } return; }
    if (!K.MONEY_METHODS.includes(r.method)) return;
    sum.byMethod[r.method] = sum.byMethod[r.method] || { amount: 0, count: 0 };
    sum.byMethod[r.method].amount += r.amount; sum.byMethod[r.method].count += 1; sum.collected += r.amount;
  });
  const r2 = (n) => Math.round(n * 100) / 100;
  Object.values(sum.byMethod).forEach((m) => { m.amount = r2(m.amount); });
  sum.collected = r2(sum.collected); sum.refunds = r2(sum.refunds); sum.net = r2(sum.collected - sum.refunds);
  return { payments: out.slice(0, lim), summary: sum, range: { from: range.$gte, to: range.$lt } };
}

// ------------------------------------------------------------------ order details
const ITEM_FLOW = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'];
async function orderDetail(businessId, user, orderId) {
  const order = await RestaurantOrder.findOne({ _id: orderId, businessId }).lean();
  if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
  C.assertBranchAccess(user, order.branchId);
  const [bills, stay] = await Promise.all([
    RestaurantBill.find({ businessId, orderId: order._id, status: { $ne: 'VOID' } }).sort({ createdAt: 1 }).lean(),
    order.stayId ? Stay.findOne({ _id: order.stayId, businessId }).select('stayNumber roomNumber guest.name status checkInDate checkOutDate totals').lean() : null,
  ]);
  const voided = await RestaurantBill.countDocuments({ businessId, orderId: order._id, status: 'VOID' });
  const uids = new Set(); [order.waiterId, order.openedBy].forEach((u) => u && uids.add(String(u)));
  (order.history || []).forEach((h) => h.by && uids.add(String(h.by)));
  bills.forEach((b) => (b.payments || []).forEach((p) => p.by && uids.add(String(p.by))));
  const uMap = new Map((await User.find({ _id: { $in: [...uids] } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  const nm = (u) => (u ? uMap.get(String(u)) || '' : '');
  const channel = channelOf(order); const d = order.delivery || {}; const ss = order.selfService || {};
  const items = (order.items || []).filter((i) => !i.parentItemId || true).map((i) => ({
    id: id(i._id), name: i.name, variantName: i.variantName || '', quantity: i.quantity, unitPrice: fromCents(i.unitPrice), total: fromCents(Math.round(i.unitPrice * i.quantity) - (i.discount || 0)),
    status: i.status, course: i.course, seatNumber: i.seatNumber || null, station: i.stationName || '', notes: i.notes || '', allergyNotes: i.allergyNotes || '',
    modifiers: (i.modifiers || []).map((m) => ({ name: m.name, group: m.groupName, quantity: m.quantity || 1, priceDelta: fromCents(m.priceDelta || 0), removal: !!m.removal })),
    isComplimentary: !!i.isComplimentary, compReason: i.compReason || '', cancelReason: i.cancelReason || '', isChild: !!i.parentItemId, comboGroup: i.comboGroup || '',
    servedAt: i.servedAt || null, readyAt: i.readyAt || null, sentAt: i.sentAt || null,
  }));
  const live = items.filter((i) => i.status !== 'CANCELLED' && i.status !== 'DRAFT' && !i.isChild);
  const billsOut = bills.map((b) => ({
    id: id(b._id), billNumber: b.billNumber, label: b.label || '', status: b.status, createdAt: b.issuedAt || b.createdAt, settledAt: b.settledAt || null, receiptNumber: b.receiptNumber || '',
    itemsTotal: fromCents(b.itemsTotal), discount: fromCents(b.discount), discountReason: (b.discountInfo && b.discountInfo.reason) || '', serviceCharge: fromCents(b.serviceCharge), scWaived: !!b.scWaived, tax: fromCents(b.tax),
    total: fromCents(b.total), paid: fromCents(b.paid), balance: fromCents(b.balance), creditAmount: fromCents(b.creditAmount || 0), waived: fromCents(b.waived || 0),
    lines: (b.lines || []).map((l) => ({ name: l.name, variantName: l.variantName || '', modifiersText: l.modifiersText || '', quantity: l.quantity, unitPrice: fromCents(l.unitPrice), total: fromCents(l.total), isComp: !!l.isComp })),
    payments: (b.payments || []).map((p) => ({ id: id(p._id), kind: p.kind || 'PAYMENT', method: p.method, amount: fromCents(p.amount), tendered: p.tendered != null ? fromCents(p.tendered) : null, change: p.change != null ? fromCents(p.change) : null, reference: p.reference || '', network: p.network || '', payerPhone: p.payerPhone || '', verifyStatus: p.verifyStatus || null, at: p.at, by: nm(p.by) || (p.by ? 'Guest / system' : '') })),
  }));
  const sumBills = (k) => billsOut.reduce((s, b) => s + b[k], 0);
  const r2 = (n) => Math.round(n * 100) / 100;
  const timeline = [{ at: order.createdAt, action: 'order.created', note: `Opened by ${nm(order.openedBy) || nm(order.waiterId) || 'staff'}` }, ...(order.history || []).filter((h) => h.action).map((h) => ({ at: h.at, action: h.action, note: h.note || '', by: nm(h.by) }))].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-60);
  return {
    order: {
      id: id(order._id), orderNumber: order.orderNumber, pickupNumber: order.pickupNumber || '', orderType: order.orderType, source: order.source, channel, channelLabel: K.CHANNELS[channel],
      status: order.status, billStatus: order.billStatus, billRequestedAt: order.billRequestedAt || null, tableName: order.tableName || '', roomNumber: order.roomNumber || '', guestCount: order.guestCount || 0,
      waiterName: order.waiterName || nm(order.waiterId), customerName: order.customerName || '', customerPhone: order.customerPhone || '', notes: order.notes || '',
      createdAt: order.createdAt, closedAt: order.closedAt || null, cancelledAt: order.cancelledAt || null, cancelReason: order.cancelReason || '',
      totals: { itemsTotal: fromCents(order.totals.itemsTotal), serviceCharge: fromCents(order.totals.serviceCharge), tax: fromCents(order.totals.tax), discount: fromCents(order.totals.discount), total: fromCents(order.totals.total) },
      delivery: channel === 'DELIVERY' ? { status: d.status || 'PENDING', contactName: d.contactName || '', phone: d.phone || '', address: d.address || '', landmark: d.landmark || '', instructions: d.instructions || '', fee: fromCents(d.fee || 0), payment: d.payment || 'CASH', online: !!d.online, riderName: d.riderName || '', assignedAt: d.assignedAt || null, outForDeliveryAt: d.outForDeliveryAt || null, deliveredAt: d.deliveredAt || null, failReason: d.failReason || '', platform: d.platform || '', etaMinutes: d.etaMinutes || null, mapsUrl: d.mapsUrl || '' } : null,
      selfService: order.source === 'KIOSK' ? { paymentMethod: ss.paymentMethod || '', paymentState: ss.paymentState || '', paidAt: ss.paidAt || null, expiresAt: ss.expiresAt || null, confirmedByName: ss.confirmedByName || '', sentToKitchen: !!ss.releasedAt } : null,
      pickup: order.pickup && order.pickup.status ? { status: order.pickup.status, collectedAt: order.pickup.collectedAt || null } : null,
      items, itemCount: live.length, servedCount: live.filter((i) => i.status === 'SERVED').length,
    },
    bills: billsOut, voidedBills: voided,
    paymentSummary: { billed: r2(sumBills('total')), paid: r2(sumBills('paid')), balance: r2(sumBills('balance')), unbilled: billsOut.length ? 0 : fromCents(order.totals.total) },
    stay: stay ? { id: id(stay._id), stayNumber: stay.stayNumber, roomNumber: stay.roomNumber, guestName: stay.guest && stay.guest.name, status: stay.status, checkInDate: stay.checkInDate, checkOutDate: stay.checkOutDate, balance: fromCents(stay.totals && stay.totals.balance) } : null,
    timeline, kitchenFlow: ITEM_FLOW,
  };
}

// ------------------------------------------------------------------ receipts at the cashier printer
const fmtN = (c) => fromCents(c).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Same paper layout the print queue already uses (see print.service / guest-portal receiptDoc), for any bill. */
async function receiptDoc(bill, ctx) {
  const b = ctx.business; const rs = b.receiptSettings || {}; const paid = bill.status === 'PAID';
  return {
    business: { name: b.name, address: b.address, phone: b.phone, pin: b.kraPin || b.taxPin },
    title: paid ? 'Receipt' : bill.status === 'PARTIAL' ? 'Bill (part paid)' : 'Bill',
    meta: [['Receipt', bill.receiptNumber], ['Bill', bill.billNumber], [bill.tableName ? 'Table' : 'Order', bill.tableName || bill.orderNumber], ['Served by', bill.waiterName], ['Date', new Date(bill.settledAt || bill.createdAt || Date.now()).toLocaleString('en-KE', { timeZone: ctx.timeZone })]].filter((m) => m[1]),
    lines: (bill.lines || []).filter((l) => !l.isComp).map((l) => ({ qty: l.quantity, name: [l.name, l.variantName && `(${l.variantName})`].filter(Boolean).join(' '), sub: l.modifiersText, total: fromCents(l.total) })),
    totals: [['Items', fmtN(bill.itemsTotal)], bill.discount ? ['Discount', '-' + fmtN(bill.discount)] : null, bill.serviceCharge ? ['Service charge', fmtN(bill.serviceCharge)] : null, bill.tax ? ['VAT included', fmtN(bill.tax)] : null, ['TOTAL', fmtN(bill.total), true], bill.paid ? ['Paid', fmtN(bill.paid)] : null, !paid && bill.balance ? ['Balance due', fmtN(bill.balance), true] : null].filter(Boolean),
    payments: (bill.payments || []).filter((p) => (p.kind || 'PAYMENT') === 'PAYMENT').map((p) => ({ label: p.method === 'MPESA' ? 'M-PESA' : p.method, value: fmtN(p.amount), sub: [p.reference, p.method === 'CASH' && p.tendered ? `Given ${fmtN(p.tendered)} Change ${fmtN(p.change || 0)}` : ''].filter(Boolean).join(' · ') })),
    footer: paid ? rs.footerMessage || 'Thank you for dining with us!' : 'Please pay at the till.',
  };
}

/** Puts the receipt on the till print queue (printer chosen by the operating profile). Never throws into a payment. */
async function queueBillReceipt(businessId, billId, { force = false } = {}) {
  return require('../restaurant/print.service').queueBillPrint(businessId, billId, { mode: 'RECEIPT', force });
}

/** Called by bill.service after a payment that a GUEST made (QR, kiosk, online order) settled a bill: it prints at the cashier by itself. */
async function onGuestBillPaid(businessId, bill) {
  if (!bill || bill.status !== 'PAID') return;
  if (!(bill.payments || []).some((p) => (p.kind || 'PAYMENT') === 'PAYMENT' && ['MPESA', 'MOBILE_MONEY'].includes(p.method))) return;
  await queueBillReceipt(businessId, bill._id);
}

async function reprintReceipt(businessId, user, billId) {
  const bill = await RestaurantBill.findOne({ _id: billId, businessId }).lean();
  if (!bill) throw ApiError.notFound('Bill not found', 'BILL_NOT_FOUND');
  C.assertBranchAccess(user, bill.branchId);
  const ctx = await C.getContext(businessId);
  const queued = await queueBillReceipt(businessId, billId, { force: true });
  if (!queued) throw ApiError.conflict('Could not reach the print queue. Nothing was changed - try again.', 'PRINT_FAILED');
  C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'receipt.reprint', entityType: 'RestaurantBill', entityId: bill._id, newValue: { bill: bill.billNumber } }).catch(() => {});
  return { queued: true, doc: await receiptDoc(bill, ctx) };
}

module.exports = { queue, overview, payments, orderDetail, drawer, recordDrawerEvent, reprintReceipt, queueBillReceipt, receiptDoc, onGuestBillPaid, channelOf, dayRange, zoneStart, buildQueue, summarize, shiftFigures };
