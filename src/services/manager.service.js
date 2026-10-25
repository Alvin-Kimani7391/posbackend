/**
 * Manager / owner command centre: ONE read-only aggregate of the day for restaurant + accommodation.
 * Every section is isolated (safe()): if one fails the rest still load and that section carries { error }.
 * All money leaves here as decimal KES. Queries use lean(), so stored cents are converted explicitly.
 */
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantBill = require('../../models/RestaurantBill');
const KitchenTicket = require('../../models/KitchenTicket');
const Reservation = require('../../models/Reservation');
const RestaurantShift = require('../../models/RestaurantShift');
const CashShift = require('../../models/CashShift');
const Payment = require('../../models/Payment');
const TipRecord = require('../../models/TipRecord');
const GuestRequest = require('../../models/GuestRequest');
const MenuItem = require('../../models/MenuItem');
const Ingredient = require('../../models/Ingredient');
const IngredientStock = require('../../models/IngredientStock');
const IngredientBatch = require('../../models/IngredientBatch');
const WasteRecord = require('../../models/WasteRecord');
const CashierShortage = require('../../models/CashierShortage');
const Room = require('../../models/Room');
const Stay = require('../../models/Stay');
const User = require('../../models/User');
const { fromCents } = require('../../utils/money');
const { inAnyWindow, DEFAULT_TZ } = require('../../utils/restaurantTime');
const { daysLeft } = require('../../utils/expiryDay');
const K = require('../../constants/manager');
const C = require('../restaurant/common');

const k = fromCents;
const MIN = 60000;
const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / MIN)) : null);
const r1 = (n) => Math.round(n * 10) / 10;
const avg = (a) => { const x = a.filter((v) => v != null); return x.length ? r1(x.reduce((s, v) => s + v, 0) / x.length) : null; };
const sid = (v) => (v ? String(v._id || v) : null);
const safe = async (fn) => { try { return await fn(); } catch (e) { console.error('[manager]', e.message); return { error: e.message || 'Could not load' }; } };

/** Day window in East Africa time (+03:00: Kenya and Tanzania). */
function dayRange(date) {
  const d = date || new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const from = new Date(`${d}T00:00:00+03:00`); const to = new Date(from.getTime() + 86400000);
  return { date: d, from, to, isToday: !date || d === new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10) };
}

function channelOf(o) {
  if (o.source === 'KIOSK') return 'SELF_SERVICE';
  if (o.source === 'QR_TABLE' || o.source === 'QR_ROOM') return 'QR_ORDER';
  if (o.source === 'ONLINE' || (o.delivery && o.delivery.online)) return 'ONLINE';
  if (o.orderType === 'DELIVERY') return 'DELIVERY';
  if (o.orderType === 'TAKEAWAY' || o.orderType === 'PICKUP') return 'TAKEAWAY';
  if (o.orderType === 'ROOM_SERVICE') return 'ROOM_SERVICE';
  if (o.orderType === 'COUNTER' || o.orderType === 'BAR_TAB') return 'COUNTER';
  return 'DINE_IN';
}

function kitchenOf(o, limit, now) {
  const items = (o.items || []).filter((i) => !i.parentItemId && i.status !== 'CANCELLED' && i.status !== 'DRAFT');
  const out = { state: 'NOT_SENT', prepMinutes: null, elapsedMinutes: null, delayedNow: false, wasLate: false, items: items.length, notServed: 0 };
  if (o.status === 'CANCELLED') { out.state = 'CANCELLED'; return out; }
  if (!items.length) return out;
  const sent = items.filter((i) => i.sentAt);
  const notDone = sent.filter((i) => !['READY', 'SERVED'].includes(i.status));
  const ready = items.filter((i) => i.status === 'READY');
  const served = items.filter((i) => i.status === 'SERVED');
  out.notServed = items.length - served.length;
  const first = sent.length ? new Date(Math.min(...sent.map((i) => +new Date(i.sentAt)))) : null;
  const doneAt = sent.map((i) => i.readyAt || i.servedAt).filter(Boolean);
  if (first && doneAt.length) out.prepMinutes = mins(first, new Date(Math.max(...doneAt.map((d) => +new Date(d)))));
  const maxPrep = Math.max(0, ...items.map((i) => i.prepMinutes || 0));
  const allowed = Math.max(limit, maxPrep);
  if (notDone.length && first) { out.elapsedMinutes = mins(first, now); out.delayedNow = out.elapsedMinutes > allowed; }
  out.wasLate = !!(out.prepMinutes != null && out.prepMinutes > allowed) || out.delayedNow;
  out.state = notDone.length ? (notDone.some((i) => ['PREPARING', 'ACCEPTED'].includes(i.status)) ? 'COOKING' : 'WAITING') : ready.length ? 'READY' : items.some((i) => i.status === 'HELD') ? 'HELD' : served.length === items.length ? 'SERVED' : 'NOT_SENT';
  return out;
}

async function overview(businessId, user, { branchId, date } = {}) {
  const scope = C.branchScope(user, branchId);
  const bf = C.branchFilter(scope);
  const base = { businessId: C.oid(businessId), ...bf };
  const R = dayRange(date); const now = new Date(); const range = { $gte: R.from, $lt: R.to };
  const ctx = await C.getContext(businessId);
  const limit = ctx.settings.kitchenDelayMinutes || 20;
  const has = (f) => ctx.features ? ctx.features[f] !== false : true;

  // ---------- orders (created today + still open from earlier) ----------
  const orderDocs = await RestaurantOrder.find({ ...base, $or: [{ createdAt: range }, { status: 'OPEN', createdAt: { $lt: R.from } }] }).sort({ createdAt: -1 }).limit(600).lean();
  const bills = orderDocs.length ? await RestaurantBill.find({ businessId: base.businessId, orderId: { $in: orderDocs.map((o) => o._id) }, status: { $ne: 'VOID' } }).lean() : [];
  const billByOrder = new Map(); bills.forEach((b) => { const a = billByOrder.get(String(b.orderId)) || []; a.push(b); billByOrder.set(String(b.orderId), a); });
  const ids = new Set();
  orderDocs.forEach((o) => { [o.waiterId, o.openedBy, o.delivery && o.delivery.riderId, o.selfService && o.selfService.confirmedBy].forEach((v) => v && ids.add(String(v))); });
  bills.forEach((b) => { [b.settledBy, ...(b.payments || []).flatMap((p) => [p.by, p.verifiedBy])].forEach((v) => v && ids.add(String(v))); });
  const todayShifts = await safe(() => CashShift.find({ ...base, $or: [{ openedAt: range }, { closedAt: range }, { status: 'OPEN' }] }).lean());
  const cashShiftRows = Array.isArray(todayShifts) ? todayShifts : [];
  cashShiftRows.forEach((s) => { ids.add(String(s.cashierId)); s.closedBy && ids.add(String(s.closedBy)); });
  const staffRows = await RestaurantShift.find({ ...base, $or: [{ scheduledStart: range }, { clockIn: range }, { status: { $in: ['ON_DUTY', 'BREAK', 'UNAVAILABLE'] } }] }).lean();
  staffRows.forEach((s) => ids.add(String(s.userId)));
  const tips = await TipRecord.find({ ...base, createdAt: range }).lean();
  tips.forEach((t) => t.waiterId && ids.add(String(t.waiterId)));
  const users = await User.find({ _id: { $in: [...ids] } }).select('name role').lean();
  const U = new Map(users.map((u) => [String(u._id), u]));
  const nm = (id) => (id && U.get(String(id)) ? U.get(String(id)).name : null);

  const rows = orderDocs.map((o) => {
    const channel = channelOf(o); const ss = o.selfService || {}; const d = o.delivery || {};
    const ob = billByOrder.get(String(o._id)) || [];
    const total = ob.length ? ob.reduce((s, b) => s + (b.total || 0), 0) : (o.totals && o.totals.total) || 0;
    const paid = ob.reduce((s, b) => s + (b.paid || 0), 0);
    const pays = ob.flatMap((b) => (b.payments || []).filter((p) => p.kind === 'PAYMENT'));
    const pending = pays.find((p) => p.verifyStatus === 'PENDING'); const rejected = pays.find((p) => p.verifyStatus === 'REJECTED');
    const last = pays[pays.length - 1];
    let payState = 'NOT_BILLED';
    if (o.status === 'CANCELLED') payState = 'CANCELLED';
    else if (ob.length && ob.every((b) => b.status === 'PAID')) payState = 'PAID';
    else if (ob.length && paid > 0) payState = 'PART_PAID';
    else if (ob.length) payState = 'UNPAID';
    else if (o.source === 'KIOSK' && ss.paymentState === 'PAID') payState = 'PAID';
    else if (o.source === 'KIOSK' && ss.paymentState) payState = ss.paymentState === 'AWAITING_CASH' ? 'AWAITING_CASH' : 'UNPAID';
    const receivedBy = nm(last && last.by) || ss.confirmedByName || null;
    const verify = rejected ? 'REJECTED' : pending ? 'PENDING' : pays.some((p) => p.verifyStatus === 'VERIFIED') ? 'VERIFIED' : pays.length ? 'OK' : null;
    const approvedBy = ss.confirmedByName || nm(last && last.verifiedBy) || (verify === 'PENDING' || verify === 'REJECTED' ? null : nm(ob[0] && ob[0].settledBy) || receivedBy);
    const waiter = o.waiterName || nm(o.waiterId) || null;
    const rider = d.riderName || null;
    const handledBy = channel === 'SELF_SERVICE' ? (ss.confirmedByName || null) : channel === 'ONLINE' || channel === 'DELIVERY' ? (rider || nm(o.openedBy)) : waiter || nm(o.openedBy);
    const handledLabel = ['SELF_SERVICE', 'ONLINE', 'QR_ORDER'].includes(channel) && !handledBy ? 'Customer (' + K.CHANNELS[channel].toLowerCase() + ')' : handledBy || 'Unassigned';
    return {
      id: String(o._id), orderNumber: o.orderNumber, pickupNumber: o.pickupNumber || null, channel, channelLabel: K.CHANNELS[channel], source: o.source, orderType: o.orderType,
      status: o.status, table: o.tableName || null, room: o.roomNumber || null, guests: o.guestCount || 0, customer: d.contactName || o.customerName || null, phone: d.phone || o.customerPhone || null,
      waiter, openedBy: nm(o.openedBy), openedById: sid(o.openedBy), handledBy, handledLabel, staffId: sid(o.waiterId) || sid(o.openedBy),
      createdAt: o.createdAt, closedAt: o.closedAt || null, ageMinutes: mins(o.createdAt, o.closedAt || now), carriedOver: o.createdAt < R.from,
      total: k(total), paid: k(paid), items: (o.items || []).filter((i) => !i.parentItemId && i.status !== 'CANCELLED' && i.status !== 'DRAFT').map((i) => `${i.quantity} x ${i.name}`),
      kitchen: kitchenOf(o, limit, now),
      payment: { state: payState, methods: [...new Set(pays.map((p) => p.method))], references: pays.map((p) => p.reference).filter(Boolean), receivedBy, approvedBy, verify },
      delivery: channel === 'ONLINE' || channel === 'DELIVERY' ? { status: d.status || 'PENDING', rider, address: d.address || null, pay: d.payment || 'CASH' } : null,
      _raw: o,
    };
  });

  // by channel / by staff
  const live = rows.filter((r) => r.status !== 'CANCELLED');
  const byChannel = Object.keys(K.CHANNELS).map((key) => {
    const a = rows.filter((r) => r.channel === key); const l = a.filter((r) => r.status !== 'CANCELLED');
    return { key, label: K.CHANNELS[key], orders: l.length, open: l.filter((r) => r.status === 'OPEN').length, cancelled: a.length - l.length, revenue: r1(l.reduce((s, r) => s + r.total, 0)), paid: l.filter((r) => r.payment.state === 'PAID').length };
  });
  const staffMap = new Map();
  live.forEach((r) => {
    const key = r.handledBy ? (r.staffId || r.handledBy) : 'CUSTOMER';
    const name = r.handledBy || 'Customers (kiosk / online / QR)';
    const s = staffMap.get(key) || { name, total: 0, revenue: 0, byChannel: {} };
    s.total += 1; s.revenue = r1(s.revenue + r.total); s.byChannel[r.channel] = (s.byChannel[r.channel] || 0) + 1; staffMap.set(key, s);
  });
  const byStaff = [...staffMap.values()].sort((a, b) => b.total - a.total);
  const orderSection = {
    summary: { total: live.length, open: live.filter((r) => r.status === 'OPEN').length, closed: live.filter((r) => r.status === 'CLOSED').length, cancelled: rows.length - live.length, unpaidOpen: live.filter((r) => r.status === 'OPEN' && !['PAID'].includes(r.payment.state)).length, carriedOver: rows.filter((r) => r.carriedOver).length, revenue: r1(live.reduce((s, r) => s + r.total, 0)), guests: live.reduce((s, r) => s + r.guests, 0) },
    byChannel, byStaff, rows: rows.map(({ _raw, ...r }) => r),
  };

  // ---------- kitchen ----------
  const kitchen = await safe(async () => {
    const t = await KitchenTicket.find({ ...base, $or: [{ receivedAt: range }, { status: { $in: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] } }] }).sort({ receivedAt: -1 }).limit(300).lean();
    const trows = t.map((x) => {
      const open = ['NEW', 'ACCEPTED', 'PREPARING'].includes(x.status);
      const maxPrep = Math.max(0, ...(x.items || []).filter((i) => !i.cancelled).map((i) => i.prepMinutes || 0));
      const lim = Math.max(limit, maxPrep);
      const age = mins(x.receivedAt, open ? now : x.readyAt || x.completedAt);
      return { ticketNumber: x.ticketNumber, orderNumber: x.orderNumber, station: x.stationName || 'Kitchen', table: x.tableName || null, waiter: x.waiterName || null, status: x.status, priority: x.priority, receivedAt: x.receivedAt, minutes: age, limitMinutes: lim, delayed: open && age > lim, wasLate: !open && age != null && age > lim, readyWaitMinutes: x.status === 'READY' ? mins(x.readyAt, now) : null, items: (x.items || []).filter((i) => !i.cancelled).map((i) => `${i.quantity} x ${i.name}`) };
    });
    const done = trows.filter((r) => !['NEW', 'ACCEPTED', 'PREPARING', 'READY'].includes(r.status) || r.status === 'READY');
    const byStation = {}; t.filter((x) => x.readyAt).forEach((x) => { const n = x.stationName || 'Kitchen'; (byStation[n] = byStation[n] || []).push(mins(x.receivedAt, x.readyAt)); });
    return {
      limitMinutes: limit,
      stats: { inKitchen: trows.filter((r) => ['NEW', 'ACCEPTED', 'PREPARING'].includes(r.status)).length, delayedNow: trows.filter((r) => r.delayed).length, readyWaiting: trows.filter((r) => r.readyWaitMinutes != null && r.readyWaitMinutes >= 10).length, finishedToday: done.length, lateFinished: trows.filter((r) => r.wasLate).length, averagePrepMinutes: avg(t.filter((x) => x.readyAt).map((x) => mins(x.receivedAt, x.readyAt))), byStation: Object.entries(byStation).map(([station, a]) => ({ station, tickets: a.length, averageMinutes: avg(a) })) },
      rows: trows.sort((a, b) => (b.delayed - a.delayed) || (b.minutes || 0) - (a.minutes || 0)).slice(0, 80),
    };
  });

  // ---------- reservations ----------
  const reservations = await safe(async () => {
    const rs = await Reservation.find({ ...base, startsAt: range, status: { $nin: ['WAITLIST'] } }).sort({ startsAt: 1 }).lean();
    const orderIds = rs.map((r) => r.orderId).filter(Boolean);
    const ro = orderIds.length ? await RestaurantOrder.find({ _id: { $in: orderIds } }).lean() : [];
    const OM = new Map(ro.map((o) => [String(o._id), o]));
    const out = rs.map((r) => {
      const o = r.orderId ? OM.get(String(r.orderId)) : null; const kt = o ? kitchenOf(o, limit, now) : null;
      const active = ['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(r.status);
      const lateMin = active && r.startsAt && now > r.startsAt ? mins(r.startsAt, now) : 0;
      const hasPre = (r.preOrder || []).length > 0;
      const food = kt ? kt.state : hasPre ? 'PRE_ORDERED' : 'NO_FOOD';
      const foodLabel = kt ? ({ COOKING: `Cooking - ${kt.elapsedMinutes ?? 0} min${kt.delayedNow ? ' (late)' : ''}`, WAITING: 'Sent, waiting for the kitchen', READY: 'Food ready', SERVED: 'Food served', HELD: 'Held', NOT_SENT: 'Not sent to kitchen', CANCELLED: 'Cancelled' }[kt.state] || kt.state) : hasPre ? 'Dishes chosen at booking - not started' : 'No food ordered yet';
      return { reservationNumber: r.reservationNumber, guest: r.guestName, phone: r.phone, partySize: r.partySize, startsAt: r.startsAt, status: r.status, source: r.source, occasion: r.occasion || null, tableCount: (r.tableIds || []).length, food, foodLabel, preOrder: (r.preOrder || []).map((p) => `${p.quantity} x ${p.name}`), orderNumber: o ? o.orderNumber : null, late: lateMin > 0, lateMinutes: lateMin, needsFoodPrep: active && hasPre && r.startsAt && (r.startsAt - now) < 45 * MIN, deposit: r.deposit && r.deposit.required ? { kind: r.deposit.kind, amount: k(r.deposit.amount), paid: !!r.deposit.paid, forfeited: !!r.deposit.forfeited } : null };
    });
    return { summary: { total: out.length, upcoming: out.filter((r) => ['BOOKED', 'CONFIRMED'].includes(r.status)).length, arrived: out.filter((r) => ['ARRIVED', 'SEATED'].includes(r.status)).length, late: out.filter((r) => r.late).length, noShow: out.filter((r) => r.status === 'NO_SHOW').length, cancelled: out.filter((r) => r.status === 'CANCELLED').length, needFoodPrep: out.filter((r) => r.needsFoodPrep).length, covers: out.filter((r) => !['CANCELLED', 'NO_SHOW'].includes(r.status)).reduce((s, r) => s + r.partySize, 0) }, rows: out };
  });

  // ---------- payments ----------
  const payments = await safe(async () => {
    const billsToday = await RestaurantBill.find({ ...base, $or: [{ issuedAt: range }, { settledAt: range }] }).lean();
    const prow = [];
    billsToday.forEach((b) => (b.payments || []).forEach((p) => {
      if (!p.at || p.at < R.from || p.at >= R.to) return;
      prow.push({ at: p.at, bill: b.billNumber, order: b.orderNumber, table: b.tableName || null, kind: p.kind, method: p.method, amount: k(p.amount), reference: p.reference || null, receivedBy: nm(p.by), approvedBy: nm(p.verifiedBy) || (p.verifyStatus === 'PENDING' ? null : nm(b.settledBy) || nm(p.by)), verifyStatus: p.verifyStatus || null, waiter: b.waiterName || null });
    }));
    const pay = prow.filter((p) => p.kind === 'PAYMENT'); const ref = prow.filter((p) => p.kind === 'REFUND');
    const money = ['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER'];
    const byMethod = {}; ['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'CREDIT', 'DEPOSIT', 'ROOM', 'OTHER'].forEach((m) => { const a = pay.filter((p) => p.method === m); byMethod[m] = { amount: r1(a.reduce((s, p) => s + p.amount, 0)), count: a.length }; });
    const rec = {}; pay.filter((p) => money.includes(p.method)).forEach((p) => { const n = p.receivedBy || 'Unknown'; const e = rec[n] || { name: n, count: 0, amount: 0, cash: 0 }; e.count++; e.amount = r1(e.amount + p.amount); if (p.method === 'CASH') e.cash = r1(e.cash + p.amount); rec[n] = e; });
    const unv = pay.filter((p) => p.verifyStatus === 'PENDING');
    return {
      totals: { collected: r1(pay.filter((p) => money.includes(p.method)).reduce((s, p) => s + p.amount, 0)), refunds: r1(ref.reduce((s, p) => s + p.amount, 0)), toRoom: byMethod.ROOM.amount, onCredit: byMethod.CREDIT.amount, depositsApplied: byMethod.DEPOSIT.amount, byMethod },
      byReceiver: Object.values(rec).sort((a, b) => b.amount - a.amount), unverified: { count: unv.length, amount: r1(unv.reduce((s, p) => s + p.amount, 0)) },
      rows: prow.sort((a, b) => b.at - a.at).slice(0, 150),
    };
  });

  // ---------- delivery / online ----------
  const delivery = await safe(async () => {
    const dr = rows.filter((r) => r.delivery).map((r) => {
      const o = r._raw; const d = o.delivery || {}; const kt = r.kitchen;
      const readyAt = (o.items || []).map((i) => i.readyAt).filter(Boolean).sort((a, b) => b - a)[0];
      const left = d.outForDeliveryAt || d.pickedUpAt;
      const paidNow = r.payment.state === 'PAID';
      const pay = paidNow ? 'PAID' : d.status === 'DELIVERED' && (d.payment || 'CASH') === 'CASH' ? 'CASH_WITH_RIDER' : 'UNPAID';
      const total = d.deliveredAt ? mins(o.createdAt, d.deliveredAt) : mins(o.createdAt, now);
      return { orderNumber: r.orderNumber, online: !!d.online, customer: r.customer, phone: r.phone, address: d.address || null, status: d.status || 'PENDING', rider: d.riderName || null, orderStatus: r.status, total: r.total, payMethod: d.payment || 'CASH', pay, placedAt: o.createdAt, prepMinutes: kt.prepMinutes, waitForRiderMinutes: readyAt && left ? mins(readyAt, left) : null, onRoadMinutes: left && d.deliveredAt ? mins(left, d.deliveredAt) : left ? mins(left, now) : null, totalMinutes: total, late: !!(d.etaMinutes && total > d.etaMinutes + 10) || (!d.deliveredAt && total > 75), cancelled: r.status === 'CANCELLED' };
    });
    const valid = dr.filter((r) => !r.cancelled); const dd = valid.filter((r) => r.status === 'DELIVERED');
    const riders = {}; valid.forEach((r) => { const n = r.rider || 'Not assigned'; const e = riders[n] || { name: n, orders: 0, delivered: 0, active: 0, _road: [], cashHeld: 0 }; e.orders++; if (r.status === 'DELIVERED') { e.delivered++; e._road.push(r.onRoadMinutes); } else e.active++; if (r.pay === 'CASH_WITH_RIDER') e.cashHeld = r1(e.cashHeld + r.total); riders[n] = e; });
    return {
      summary: { total: valid.length, online: valid.filter((r) => r.online).length, byStaff: valid.filter((r) => !r.online).length, active: valid.filter((r) => !['DELIVERED', 'FAILED'].includes(r.status)).length, delivered: dd.length, failed: valid.filter((r) => r.status === 'FAILED').length, cancelled: dr.length - valid.length, late: valid.filter((r) => r.late).length, unpaid: valid.filter((r) => r.pay === 'UNPAID').length, unpaidAmount: r1(valid.filter((r) => r.pay === 'UNPAID').reduce((s, r) => s + r.total, 0)), averagePrepMinutes: avg(valid.map((r) => r.prepMinutes)), averageOnRoadMinutes: avg(dd.map((r) => r.onRoadMinutes)), averageTotalMinutes: avg(dd.map((r) => r.totalMinutes)), cashWithRiders: r1(valid.filter((r) => r.pay === 'CASH_WITH_RIDER').reduce((s, r) => s + r.total, 0)) },
      riders: Object.values(riders).map(({ _road, ...e }) => ({ ...e, averageOnRoadMinutes: avg(_road) })), rows: dr.sort((a, b) => b.placedAt - a.placedAt),
    };
  });

  // ---------- guest QR orders ----------
  const qr = await safe(async () => {
    const gr = await GuestRequest.find({ ...base, createdAt: range }).sort({ createdAt: -1 }).limit(200).lean();
    const OM = new Map(rows.map((r) => [r.id, r]));
    const qrows = gr.map((g) => { const o = g.orderId ? OM.get(String(g.orderId)) : null; return { at: g.createdAt, kind: g.kind, place: g.kind === 'ROOM' ? `Room ${g.roomNumber || ''}` : `Table ${g.tableName || ''}`, guest: g.guest && g.guest.name || null, status: g.status, mode: g.mode, items: (g.items || []).map((i) => `${i.quantity} x ${i.name}`), estimated: k(g.estimatedTotal || 0), respondedInMinutes: g.decision && g.decision.at ? mins(g.createdAt, g.decision.at) : null, decidedBy: g.decision && g.decision.byName || null, orderNumber: o ? o.orderNumber : null, kitchenState: o ? o.kitchen.state : null, paymentState: o ? o.payment.state : null, waiter: o ? o.waiter : null }; });
    const pending = qrows.filter((r) => r.status === 'PENDING');
    return { summary: { requests: qrows.length, pending: pending.length, accepted: qrows.filter((r) => r.status === 'ACCEPTED').length, rejected: qrows.filter((r) => r.status === 'REJECTED').length, expired: qrows.filter((r) => r.status === 'EXPIRED').length, table: qrows.filter((r) => r.kind === 'TABLE').length, room: qrows.filter((r) => r.kind === 'ROOM').length, averageResponseMinutes: avg(qrows.map((r) => r.respondedInMinutes)), revenue: r1(rows.filter((r) => r.channel === 'QR_ORDER' && r.status !== 'CANCELLED').reduce((s, r) => s + r.total, 0)) }, rows: qrows };
  });

  // ---------- menu for the day ----------
  const menu = await safe(async () => {
    const items = await MenuItem.find({ businessId: base.businessId, status: 'active' }).sort({ sortOrder: 1, name: 1 }).lean();
    const sold = new Map(); orderDocs.filter((o) => o.status !== 'CANCELLED').forEach((o) => (o.items || []).forEach((i) => { if (i.menuItemId && i.status !== 'CANCELLED') sold.set(String(i.menuItemId), (sold.get(String(i.menuItemId)) || 0) + i.quantity); }));
    const mrows = items.map((m) => {
      const ov = branchId ? (m.branchOverrides || []).find((x) => sid(x.branchId) === String(branchId)) : null;
      const off = ov && ov.available === false; const so = !!(m.soldOut && m.soldOut.flag);
      const per = (m.menuPeriods || []).length ? inAnyWindow(now, ctx.timeZone || DEFAULT_TZ, m.menuPeriods) : true;
      const promo = (m.timedPrices || []).some((t) => inAnyWindow(now, ctx.timeZone || DEFAULT_TZ, t.windows || []));
      return { name: m.name, price: k((ov && ov.price) || m.basePrice), state: so ? 'SOLD_OUT' : off ? 'OFF_HERE' : !per ? 'OUT_OF_PERIOD' : 'AVAILABLE', soldOutReason: so ? m.soldOut.reason || null : null, promo, soldToday: sold.get(String(m._id)) || 0, prepMinutes: m.prepMinutes, station: m.stationCode, periods: (m.menuPeriods || []).map((w) => `${(w.days || []).length ? w.days.map((d) => 'SunMonTueWedThuFriSat'.slice(d * 3, d * 3 + 3)).join(' ') : 'Every day'} ${w.start || ''}${w.end ? '-' + w.end : ''}`.trim()) };
    });
    const cnt = (s) => mrows.filter((r) => r.state === s).length;
    return { summary: { total: mrows.length, available: cnt('AVAILABLE'), soldOut: cnt('SOLD_OUT'), outOfPeriod: cnt('OUT_OF_PERIOD'), offHere: cnt('OFF_HERE'), promos: mrows.filter((r) => r.promo).length, neverSold: mrows.filter((r) => !r.soldToday).length }, rows: mrows };
  });

  // ---------- ingredient stock + expiry ----------
  const stock = await safe(async () => {
    const agg = await IngredientStock.aggregate([{ $match: base }, { $group: { _id: '$ingredientId', qty: { $sum: '$quantity' } } }]);
    const ing = await Ingredient.find({ businessId: base.businessId, status: 'active' }).lean();
    const Q = new Map(agg.map((a) => [String(a._id), a.qty]));
    const unit = (i) => (i.baseUnit === 'g' ? 'g' : i.baseUnit === 'ml' ? 'ml' : 'pcs');
    const irows = ing.map((i) => { const q = Q.get(String(i._id)) || 0; const state = q < 0 ? 'NEGATIVE' : q === 0 ? 'OUT' : i.lowStockLevel && q <= i.lowStockLevel ? 'LOW' : i.reorderLevel && q <= i.reorderLevel ? 'REORDER' : 'OK'; return { name: i.name, quantity: Math.round(q * 100) / 100, unit: unit(i), quantityText: `${Math.round(q * 100) / 100} ${unit(i)}`, state, low: i.lowStockLevel || 0, value: k(Math.max(0, q) * (i.costPerBase || 0)) }; }).sort((a, b) => ['NEGATIVE', 'OUT', 'LOW', 'REORDER', 'OK'].indexOf(a.state) - ['NEGATIVE', 'OUT', 'LOW', 'REORDER', 'OK'].indexOf(b.state));
    const t = ctx.settings.tracking || {}; const crit = t.expiryCriticalDays ?? 3; const warn = Math.max(t.expiryWarningDays ?? 7, crit);
    const bt = await IngredientBatch.find({ ...base, status: 'ACTIVE', quantity: { $gt: 0 }, expiryDate: { $ne: null, $lte: new Date(Date.now() + warn * 86400000) } }).sort({ expiryDate: 1 }).limit(100).lean();
    const IM = new Map(ing.map((i) => [String(i._id), i]));
    const erows = bt.map((b) => { const i = IM.get(String(b.ingredientId)); const dl = daysLeft(b.expiryDate); const bucket = dl < 0 ? 'EXPIRED' : dl <= crit ? 'CRITICAL' : 'WARNING'; return { name: i ? i.name : 'Ingredient', batch: b.batchNumber, location: b.location, expiryDate: b.expiryDate, daysLeft: dl, bucket, quantityText: `${Math.round(b.quantity * 100) / 100} ${i ? unit(i) : ''}`.trim(), value: k(b.quantity * (b.costPerBase || 0)) }; });
    const c = (s) => irows.filter((r) => r.state === s).length; const e = (s) => erows.filter((r) => r.bucket === s);
    return { summary: { ingredients: irows.length, out: c('OUT'), low: c('LOW'), reorder: c('REORDER'), negative: c('NEGATIVE'), stockValue: r1(irows.reduce((s, r) => s + r.value, 0)), expired: e('EXPIRED').length, critical: e('CRITICAL').length, warning: e('WARNING').length, expiredValue: r1(e('EXPIRED').reduce((s, r) => s + r.value, 0)) }, ingredients: irows.filter((r) => r.state !== 'OK').concat(irows.filter((r) => r.state === 'OK').slice(0, 20)), expiry: erows };
  });

  // ---------- shifts (staff) ----------
  const ordersBy = new Map(); live.forEach((r) => { if (r.staffId) ordersBy.set(r.staffId, (ordersBy.get(r.staffId) || 0) + 1); });
  const tipBy = new Map(); tips.forEach((t) => { if (t.waiterId) tipBy.set(String(t.waiterId), (tipBy.get(String(t.waiterId)) || 0) + t.amount); });
  const staff = staffRows.map((s) => ({ name: nm(s.userId) || 'Staff', role: s.role || (U.get(String(s.userId)) || {}).role, status: s.status, scheduledStart: s.scheduledStart || null, scheduledEnd: s.scheduledEnd || null, clockIn: s.clockIn || null, clockOut: s.clockOut || null, hoursOnDuty: s.clockIn ? Math.round(((s.clockOut || now) - s.clockIn) / 36000) / 100 : null, acceptingTables: s.acceptingTables, ordersHandled: ordersBy.get(String(s.userId)) || 0, tips: k(tipBy.get(String(s.userId)) || 0), notClockedIn: s.status === 'SCHEDULED' && s.scheduledStart && s.scheduledStart < new Date(now - 10 * MIN) }));

  // ---------- cash box ----------
  const cashBox = await safe(async () => {
    const sids = cashShiftRows.map((s) => s._id);
    const cp = sids.length ? await Payment.aggregate([{ $match: { shiftId: { $in: sids }, method: 'CASH', status: { $in: ['SUCCESS', 'REFUNDED'] } } }, { $group: { _id: { s: '$shiftId', st: '$status' }, amt: { $sum: '$amount' } } }]) : [];
    const cin = new Map(), cout = new Map(); cp.forEach((x) => (x._id.st === 'SUCCESS' ? cin : cout).set(String(x._id.s), x.amt));
    const crows = cashShiftRows.map((s) => { const sales = cin.get(String(s._id)) || 0; const refunds = cout.get(String(s._id)) || 0; const expected = s.status === 'CLOSED' && s.expectedCash != null ? s.expectedCash : (s.openingCash || 0) + sales - refunds; return { cashier: nm(s.cashierId) || 'Cashier', status: s.status, openedAt: s.openedAt, closedAt: s.closedAt || null, openingCash: k(s.openingCash || 0), cashSales: k(sales), refunds: k(refunds), expectedCash: k(expected), actualCash: s.actualCash != null ? k(s.actualCash) : null, difference: s.status === 'CLOSED' && s.cashDifference != null ? k(s.cashDifference) : null, closedBy: nm(s.closedBy), offlineReview: s.offlineReview !== 'NONE' ? s.offlineReview : null }; });
    const outstanding = await CashierShortage.aggregate([{ $match: { ...base, status: { $in: ['OUTSTANDING', 'PARTIAL'] } } }, { $group: { _id: null, n: { $sum: 1 }, bal: { $sum: '$balance' } } }]);
    return { totals: { openDrawers: crows.filter((r) => r.status === 'OPEN').length, cashInDrawers: r1(crows.filter((r) => r.status === 'OPEN').reduce((s, r) => s + r.expectedCash, 0)), short: r1(crows.filter((r) => r.difference < 0).reduce((s, r) => s + r.difference, 0)), over: r1(crows.filter((r) => r.difference > 0).reduce((s, r) => s + r.difference, 0)), shortagesOutstandingCount: outstanding[0] ? outstanding[0].n : 0, shortagesOutstanding: k(outstanding[0] ? outstanding[0].bal : 0) }, rows: crows };
  });

  // ---------- tips ----------
  const tipSection = (() => {
    const bw = new Map(); tips.forEach((t) => { const n = nm(t.waiterId) || 'Pool / unassigned'; const e = bw.get(n) || { name: n, count: 0, amount: 0 }; e.count++; e.amount += t.amount; bw.set(n, e); });
    return { total: k(tips.reduce((s, t) => s + t.amount, 0)), count: tips.length, unpaidTotal: k(tips.filter((t) => t.status !== 'PAID_OUT').reduce((s, t) => s + t.amount, 0)), byWaiter: [...bw.values()].map((e) => ({ ...e, amount: k(e.amount) })).sort((a, b) => b.amount - a.amount), byMethod: ['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER'].map((m) => ({ method: m, amount: k(tips.filter((t) => t.method === m).reduce((s, t) => s + t.amount, 0)) })).filter((x) => x.amount) };
  })();

  // ---------- losses ----------
  const loss = await safe(async () => {
    const lines = []; let voidVal = 0, voidN = 0;
    orderDocs.forEach((o) => (o.items || []).forEach((i) => { if (i.status === 'CANCELLED' && i.cancelledAfterPrep && i.cancelledAt >= R.from && i.cancelledAt < R.to) { voidN++; voidVal += (i.unitPrice || 0) * (i.quantity || 0); } }));
    if (voidN) lines.push({ kind: 'Cancelled after cooking', count: voidN, amount: k(voidVal) });
    const waste = await WasteRecord.aggregate([{ $match: { ...base, createdAt: range } }, { $group: { _id: '$kind', n: { $sum: 1 }, cost: { $sum: '$cost' } } }]);
    const WL = { WASTE: 'Wasted', SPOILAGE: 'Spoiled', EXPIRED: 'Expired stock', STAFF_MEAL: 'Staff meals', COMPLIMENTARY: 'Complimentary', VOID_AFTER_PREP: 'Void after prep', REMAKE: 'Remade dishes' };
    waste.forEach((w) => lines.push({ kind: WL[w._id] || w._id, count: w.n, amount: k(w.cost) }));
    const bt = await RestaurantBill.aggregate([{ $match: { ...base, $or: [{ issuedAt: range }, { settledAt: range }], status: { $ne: 'VOID' } } }, { $group: { _id: null, disc: { $sum: '$discount' }, comp: { $sum: '$compValue' }, waived: { $sum: '$waived' } } }]);
    const b = bt[0] || {};
    if (b.disc) lines.push({ kind: 'Discounts given', count: null, amount: k(b.disc) });
    if (b.waived) lines.push({ kind: 'Bills written off', count: null, amount: k(b.waived) });
    const short = Array.isArray(cashBox && cashBox.rows) ? Math.abs(cashBox.totals.short) : 0;
    if (short) lines.push({ kind: 'Cash short at shift close', count: cashBox.rows.filter((r) => r.difference < 0).length, amount: short });
    const exp = stock && stock.summary ? stock.summary.expiredValue : 0;
    if (exp) lines.push({ kind: 'Expired batches still in stock', count: stock.summary.expired, amount: exp });
    return { total: r1(lines.reduce((s, l) => s + l.amount, 0)), lines: lines.sort((a, b2) => b2.amount - a.amount) };
  });

  // ---------- accommodation ----------
  const accommodation = has('accommodation') ? await safe(async () => {
    const [rooms, stays] = await Promise.all([Room.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]), Stay.aggregate([{ $match: { ...base, status: { $in: ['CHECKED_IN', 'RESERVED'] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }])]);
    const rc = Object.fromEntries(rooms.map((r) => [r._id, r.n])); const total = rooms.reduce((s, r) => s + r.n, 0);
    const sc = Object.fromEntries(stays.map((r) => [r._id, r.n]));
    return { rooms: total, occupied: rc.OCCUPIED || 0, available: rc.AVAILABLE || 0, outOfOrder: rc.OUT_OF_ORDER || 0, checkedIn: sc.CHECKED_IN || 0, reserved: sc.RESERVED || 0, occupancyPercent: total ? Math.round(((rc.OCCUPIED || 0) / total) * 100) : 0 };
  }) : null;

  // ---------- alerts + KPIs ----------
  const A = []; const al = (level, area, text) => A.push({ level, area, text });
  const ks = kitchen && kitchen.stats, rs = reservations && reservations.summary, ds = delivery && delivery.summary, qs = qr && qr.summary, ss = stock && stock.summary, ps = payments && payments.unverified, cs = cashBox && cashBox.totals;
  if (ks && ks.delayedNow) al('high', 'kitchen', `${ks.delayedNow} order(s) running late in the kitchen`);
  if (ks && ks.readyWaiting) al('warn', 'kitchen', `${ks.readyWaiting} ready order(s) waiting 10+ minutes to be served`);
  if (cs && cs.short < 0) al('high', 'cash', `Cash short ${Math.abs(cs.short).toFixed(2)} at shift close`);
  if (cs && cs.shortagesOutstandingCount) al('warn', 'cash', `${cs.shortagesOutstandingCount} cashier shortage(s) still unpaid`);
  if (ds && ds.late) al('high', 'delivery', `${ds.late} delivery order(s) later than promised`);
  if (ds && ds.unpaid) al('warn', 'delivery', `${ds.unpaid} delivery order(s) not paid`);
  if (ds && ds.cashWithRiders) al('info', 'delivery', `${ds.cashWithRiders.toFixed(2)} cash still held by riders`);
  if (rs && rs.late) al('warn', 'reservations', `${rs.late} reservation(s) running late`);
  if (rs && rs.needFoodPrep) al('warn', 'reservations', `${rs.needFoodPrep} booking(s) with pre-ordered food starting within 45 minutes`);
  if (ps && ps.count) al('warn', 'payments', `${ps.count} mobile-money payment(s) not yet verified`);
  if (qs && qs.pending) al('warn', 'qr', `${qs.pending} guest QR order(s) waiting for acceptance`);
  if (ss && ss.expired) al('high', 'stock', `${ss.expired} expired batch(es) still in stock`);
  if (ss && ss.critical) al('warn', 'stock', `${ss.critical} batch(es) expiring soon`);
  if (ss && (ss.low || ss.out)) al('warn', 'stock', `${ss.low + ss.out} ingredient(s) low or out`);
  if (ss && ss.negative) al('warn', 'stock', `${ss.negative} ingredient(s) below zero`);
  const nci = staff.filter((s) => s.notClockedIn).length; if (nci) al('warn', 'shifts', `${nci} scheduled staff not clocked in`);
  if (orderSection.summary.carriedOver) al('warn', 'orders', `${orderSection.summary.carriedOver} order(s) still open from earlier days`);
  const so = menu && menu.summary && menu.summary.soldOut; if (so) al('info', 'menu', `${so} menu item(s) marked sold out`);
  const rank = { high: 0, warn: 1, info: 2 }; A.sort((a, b) => rank[a.level] - rank[b.level]);
  const os = orderSection.summary; const pt = payments && payments.totals;
  return {
    meta: { date: R.date, isToday: R.isToday, generatedAt: now, branchId: branchId || null, kitchenLimitMinutes: limit, timeZone: 'Africa/Nairobi', role: user.role },
    kpis: { revenue: os.revenue, orders: os.total, openOrders: os.open, closedOrders: os.closed, cancelledOrders: os.cancelled, guests: os.guests, averageOrderValue: os.total ? r1(os.revenue / os.total) : 0, unpaidOpenOrders: os.unpaidOpen, collected: pt ? pt.collected : null, netCollected: pt ? r1(pt.collected - pt.refunds) : null, cashInDrawers: cs ? cs.cashInDrawers : null, openDrawers: cs ? cs.openDrawers : null, tips: tipSection.total, inKitchen: ks ? ks.inKitchen : null, delayedNow: ks ? ks.delayedNow : null, averagePrepMinutes: ks ? ks.averagePrepMinutes : null, reservationsToday: rs ? rs.total : null, deliveriesActive: ds ? ds.active : null, onlineOrders: ds ? ds.online : null, qrPending: qs ? qs.pending : null, staffOnDuty: staff.filter((s) => ['ON_DUTY', 'BREAK'].includes(s.status)).length, loss: loss && loss.total != null ? loss.total : null, occupancyPercent: accommodation && accommodation.occupancyPercent != null ? accommodation.occupancyPercent : null },
    alerts: A, orders: orderSection, kitchen, reservations, shifts: { staff, cash: cashBox && cashBox.rows ? cashBox.rows : [] }, payments, delivery, qr, menu, stock, tips: tipSection, cashBox, accommodation, loss,
  };
}

module.exports = { overview };