/**
 * Print queue. A "printer station" is a staff device switched to auto-print (js/core/hx-autoprint.js): it collects the PrintJobs for its
 * physical printer (KITCHEN, BAR or CASHIER) and prints them. Nothing here ever throws into an order or a payment.
 *
 * WHICH printer prints WHAT is decided by the restaurant's operating profile (constants/operations.js -> ctx.ops):
 *   kitchen ticket   -> kitchen printer, else the till printer (one-printer restaurants), else the bar printer
 *   bar ticket       -> bar printer, else the kitchen printer, else the till printer
 *   waiter slip      -> till printer, else the kitchen printer  (the "second receipt" of a one-printer restaurant)
 *   bill / receipt   -> till printer, else the kitchen printer
 * A role with no printer at all queues nothing: the restaurant simply has no paper for it.
 *
 * Kitchen tickets are built FROM THE ORDER, not from a KitchenTicket, so a restaurant with no kitchen screen still gets them.
 * Restaurants that were never configured keep the old rule: paper only for guest QR / kiosk orders.
 */
const PrintJob = require('../../models/PrintJob');
const KitchenStation = require('../../models/KitchenStation');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantBill = require('../../models/RestaurantBill');
const ApiError = require('../../utils/ApiError');
const { nextSequence, pad } = require('../../models/Counter');
const { localParts } = require('../../utils/restaurantTime');
const { fromCents } = require('../../utils/money');
const C = require('./common');

const TARGETS = ['KITCHEN', 'BAR', 'CASHIER'];
const hhmm = (d, tz) => { try { return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'Africa/Nairobi' }); } catch (e) { return ''; } };
const TYPE_LABEL = { DINE_IN: 'Dine-in', TAKEAWAY: 'Take away', DELIVERY: 'DELIVERY', COUNTER: 'Counter', BAR_TAB: 'Bar tab', ROOM_SERVICE: 'Room service', PICKUP: 'Pickup' };
const SOURCE_LABEL = { WAITER: 'Waiter', POS: 'Cashier', PHONE: 'Phone order', ONLINE: 'Online order', KIOSK: 'Self-service (PAID)', QR_TABLE: 'Guest phone (table)', QR_ROOM: 'Guest phone (room)', FRONT_DESK: 'Front desk' };
const KOT_TITLE = { NEW: 'order', ADDITION: 'ADD-ON order', FIRE: 'FIRE course', REPRINT: 'REPRINT' };

const modsText = (i) => i.modifiersText || (i.modifiers || []).map((m) => (m.removal ? `NO ${String(m.name).replace(/^no /i, '')}` : m.quantity > 1 ? `${m.name} x${m.quantity}` : m.name)).join(', ');
const lineName = (i) => i.name + (i.variantName ? ` (${i.variantName})` : '');
const placeOf = (o) => (o.tableName ? `Table ${o.tableName}` : o.roomNumber ? `Room ${o.roomNumber}` : o.pickupNumber ? `${TYPE_LABEL[o.orderType] || o.orderType} ${o.pickupNumber}` : (TYPE_LABEL[o.orderType] || o.orderType));
const planOf = async (ctxIn, businessId, session) => (ctxIn && ctxIn.ops ? ctxIn : C.getContext(businessId, session));
const opts = (session) => (session ? { session } : {});

/** One kitchen ticket's worth of lines: { stationType, stationName, ticketNumber, type, allergyAlert, items:[{ itemId, name, quantity, ... }] } */
function groupOf(items, extra = {}) {
  const live = items.filter((i) => !i.cancelled && i.status !== 'CANCELLED');
  return { items: live, allergyAlert: live.some((i) => i.allergyNotes || (i.allergens || []).length), ...extra };
}
async function groupByStation(order, items, session) {
  const by = new Map();
  for (const i of items) {
    if (i.cancelled || i.status === 'CANCELLED') continue;
    const k = String(i.stationId || i.stationCode || 'DEFAULT');
    if (!by.has(k)) by.set(k, { stationType: i.stationType || 'KITCHEN', stationName: i.stationName, items: [] });
    by.get(k).items.push(i);
  }
  return [...by.values()];
}

function kotDoc(order, g, { tz, plan, heading }) {
  const place = placeOf(order);
  const bar = g.stationType === 'BAR';
  return {
    title: `${bar ? 'Bar' : 'Kitchen'} ${heading || 'order'}`, big: true,
    highlight: { label: place, value: g.ticketNumber || order.orderNumber },
    meta: [['Order', order.orderNumber], ['Type', TYPE_LABEL[order.orderType] || order.orderType], ['Source', SOURCE_LABEL[order.source] || order.source], ['Guest', order.customerName], ['Guests', order.guestCount > 1 ? order.guestCount : ''], ['Waiter', order.waiterName], ['Time', hhmm(Date.now(), tz)], ['Station', g.stationName && !['Kitchen', 'Bar'].includes(g.stationName) ? g.stationName : ''], ['Note', order.notes], ['URGENT', order.priority === 'URGENT' ? 'YES' : '']],
    lines: g.items.map((i) => ({ qty: i.quantity, name: lineName(i), sub: [(i.course > 1 ? `Course ${i.course}` : ''), (i.seatNumber ? `Seat ${i.seatNumber}` : ''), modsText(i), i.notes && `NOTE: ${i.notes}`, i.allergyNotes && `ALLERGY: ${i.allergyNotes}`].filter(Boolean).join(' | ') })),
    footer: g.allergyAlert ? '*** ALLERGY ALERT ***' : '',
  };
}

/** The second slip of a one-printer restaurant: what was ordered, to carry to the table or keep with the order. */
function slipDoc(order, groups, { tz, plan, heading }) {
  const all = groups.flatMap((g) => g.items);
  const withPrices = !!plan.print.slipPrices;
  let total = 0;
  const lines = all.map((i) => {
    const src = (i.itemId && order.items && order.items.id && order.items.id(i.itemId)) || i;
    const cents = Math.round((src.unitPrice || 0) * (i.quantity || 1)); total += cents;
    return { qty: i.quantity, name: lineName(i), sub: modsText(i), ...(withPrices ? { total: fromCents(cents) } : {}) };
  });
  return {
    title: `Order slip - waiter copy${heading && heading !== 'order' ? ` (${heading})` : ''}`,
    highlight: { label: placeOf(order), value: order.orderNumber },
    meta: [['Type', TYPE_LABEL[order.orderType] || order.orderType], ['Guest', order.customerName], ['Phone', order.orderType === 'DELIVERY' ? order.customerPhone : ''], ['Deliver to', order.delivery && order.delivery.address], ['Waiter', order.waiterName], ['Time', hhmm(Date.now(), tz)]],
    lines,
    totals: withPrices ? [['Added now', fromCents(total).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), true]] : [],
    footer: 'Not a receipt. The bill is printed separately.',
  };
}

/** Core: queue the kitchen / bar tickets (and the waiter slip) for already-built groups. Never throws. */
async function queueGroups(order, groups, { ctx, session, type = 'NEW' }) {
  try {
    const plan = ctx.ops; const tz = ctx.timeZone; const heading = KOT_TITLE[type] || 'order'; const place = placeOf(order);
    const copies = plan.configured ? plan.print.kotCopies : 1;
    for (const g of groups) {
      if (!g.items.length) continue;
      const target = plan.route(g.stationType === 'BAR' ? 'BAR' : 'KITCHEN'); if (!target) continue;
      const doc = kotDoc(order, g, { tz, plan, heading });
      for (let n = 1; n <= copies; n += 1) await PrintJob.create([{ businessId: order.businessId, branchId: order.branchId, target, kind: 'KOT', title: `${place} ${g.ticketNumber || order.orderNumber}${n > 1 ? ` (copy ${n})` : ''}`, doc, refId: g.refId, orderId: order._id }], opts(session));
    }
    if (plan.printsWaiterSlip && groups.some((g) => g.items.length)) {
      const target = plan.route('WAITER');
      if (target) await PrintJob.create([{ businessId: order.businessId, branchId: order.branchId, target, kind: 'SLIP', title: `${place} waiter copy ${order.orderNumber}`, doc: slipDoc(order, groups.filter((g) => g.items.length), { tz, plan, heading }), orderId: order._id }], opts(session));
    }
  } catch (e) { console.error('[print] could not queue kitchen ticket:', e.message); }
}

/** Order items just sent, NO kitchen screen involved (a restaurant with only a kitchen printer, or nothing at all). */
async function enqueueOrderKot(order, items, { ctx, session, type = 'NEW' } = {}) {
  try {
    ctx = await planOf(ctx, order.businessId, session);
    if (!ctx.ops.printsKot(order.source)) return;
    const ymd = localParts(new Date(), ctx.timeZone).ymd;
    const groups = await groupByStation(order, items, session);
    for (const g of groups) { const seq = await nextSequence(order.businessId, `kot:${order.branchId}:${ymd}`, session); g.ticketNumber = `K${ymd.slice(4)}-${pad(seq, 4)}`; g.items = g.items.map((i) => ({ itemId: i._id, ...(i.toObject ? i.toObject({ transform: false, virtuals: false }) : i), _id: i._id })); }
    await queueGroups(order, groups, { ctx, session, type });
  } catch (e) { console.error('[print] could not queue order ticket:', e.message); }
}

/** Tickets already created for a kitchen screen: ALSO put them on paper when the profile says so (screen + printer restaurants). */
async function enqueueKot(order, tickets, { session, tz, ctx } = {}) {
  try {
    ctx = await planOf(ctx, order.businessId, session);
    if (!ctx.ops.printsKot(order.source)) return;
    const groups = [];
    for (const t of tickets) {
      if (!t.items || !t.items.length) continue;
      let stationType = 'KITCHEN';
      if (t.stationId) { const st = await KitchenStation.findById(t.stationId).select('type').session(session || null); if (st && st.type === 'BAR') stationType = 'BAR'; }
      const g = groupOf(t.items.map((i) => ({ ...(i.toObject ? i.toObject() : i), itemId: i.orderItemId })), { stationType, stationName: t.stationName, ticketNumber: t.ticketNumber, refId: t._id });
      groups.push(g);
    }
    await queueGroups(order, groups, { ctx: { ...ctx, timeZone: tz || ctx.timeZone }, session, type: (tickets[0] && tickets[0].type) || 'NEW' });
  } catch (e) { console.error('[print] could not queue kitchen ticket:', e.message); }
}

/** A cancelled (or changed) line that was already sent: the kitchen must be told on paper too. changes: [{ item, cancelled }] */
async function enqueueCancelSlip(order, changes, { ctx, session, reason } = {}) {
  try {
    ctx = await planOf(ctx, order.businessId, session);
    const plan = ctx.ops; if (!plan.printsCancel || !changes || !changes.length) return;
    const by = new Map();
    for (const c of changes) { const bar = c.item.stationType === 'BAR' ? 'BAR' : 'KITCHEN'; if (!by.has(bar)) by.set(bar, []); by.get(bar).push(c); }
    const place = placeOf(order);
    for (const [role, list] of by) {
      const target = plan.route(role); if (!target) continue;
      const allCancelled = list.every((c) => c.cancelled);
      await PrintJob.create([{ businessId: order.businessId, branchId: order.branchId, target, kind: 'VOID', title: `${allCancelled ? 'CANCELLED' : 'CHANGED'} ${place}`, orderId: order._id, doc: {
        title: allCancelled ? '*** CANCELLED ***' : '*** ORDER CHANGED ***', big: true, highlight: { label: place, value: order.orderNumber },
        meta: [['Time', hhmm(Date.now(), ctx.timeZone)], ['Waiter', order.waiterName], ['Reason', reason]],
        lines: list.map((c) => ({ qty: c.item.quantity, name: `${c.cancelled ? 'CANCEL ' : ''}${lineName(c.item)}`, sub: [modsText(c.item), c.item.notes && `NOTE: ${c.item.notes}`, c.item.allergyNotes && `ALLERGY: ${c.item.allergyNotes}`].filter(Boolean).join(' | ') })),
        footer: allCancelled ? 'Stop preparing these items.' : 'Check the new instructions.',
      } }], opts(session));
    }
  } catch (e) { console.error('[print] could not queue cancel slip:', e.message); }
}

/** Re-print the kitchen tickets for what is still on an order (lost paper, jam, printer was off). Works with or without a kitchen screen. */
async function reprintOrderKot(businessId, user, orderId, { reason } = {}) {
  const order = await RestaurantOrder.findOne({ _id: orderId, businessId });
  if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
  C.assertOrderAccess(user, order);
  const ctx = await C.getContext(businessId);
  if (!ctx.ops.route('KITCHEN')) throw ApiError.conflict('This restaurant has no printer set up for kitchen tickets', 'NO_PRINTER');
  const sent = order.items.filter((i) => !['DRAFT', 'HELD', 'CANCELLED', 'SERVED'].includes(i.status));
  if (!sent.length) throw ApiError.conflict('Nothing is waiting in the kitchen for this order', 'NOTHING_TO_PRINT');
  const ymd = localParts(new Date(), ctx.timeZone).ymd;
  const groups = await groupByStation(order, sent, null);
  for (const g of groups) { const seq = await nextSequence(businessId, `kot:${order.branchId}:${ymd}`); g.ticketNumber = `K${ymd.slice(4)}-${pad(seq, 4)}`; g.items = g.items.map((i) => ({ itemId: i._id, ...i.toObject({ transform: false, virtuals: false }), _id: i._id })); }
  const forced = { ...ctx, ops: { ...ctx.ops, printsWaiterSlip: false, print: { ...ctx.ops.print, kotCopies: 1 }, route: ctx.ops.route } };
  await queueGroups(order, groups, { ctx: forced, type: 'REPRINT' });
  C.audit({ businessId, branchId: order.branchId, userId: user._id, action: 'restaurant.kot.reprint_order', entityType: 'RestaurantOrder', entityId: order._id, newValue: { reason } }).catch(() => {});
  return { queued: groups.length };
}

/**
 * Customer bill (unpaid) or receipt (paid) on the till printer. mode: 'BILL' | 'RECEIPT'.
 * RECEIPT is queued once per bill unless `force`; BILL is queued every time (a refreshed bill must be printed again).
 */
async function queueBillPrint(businessId, billId, { mode = 'RECEIPT', force = false, ctx } = {}) {
  try {
    const bill = await RestaurantBill.findOne({ _id: billId, businessId }).lean(); if (!bill) return false;
    ctx = await planOf(ctx, businessId);
    const target = ctx.ops.route('CASHIER'); if (!target) return false;
    const cashier = require('../cashier/cashier.service');
    const isReceipt = mode === 'RECEIPT';
    const title = isReceipt ? `Receipt ${bill.receiptNumber || bill.billNumber}` : `Bill ${bill.billNumber}`;
    if (isReceipt && !force && await PrintJob.exists({ businessId, kind: 'RECEIPT', refId: bill._id, title: /^Receipt / })) return true;
    const doc = await cashier.receiptDoc(bill, ctx);
    const copies = isReceipt ? (ctx.ops.configured ? ctx.ops.print.receiptCopies : 1) : 1;
    for (let n = 1; n <= copies; n += 1) await PrintJob.create({ businessId, branchId: bill.branchId, target, kind: isReceipt ? 'RECEIPT' : 'BILL', title: `${title}${force ? ' (copy)' : ''}${n > 1 ? ` (copy ${n})` : ''}`, doc, refId: bill._id, orderId: bill.orderId });
    return true;
  } catch (e) { console.error('[print] could not queue bill print:', e.message); return false; }
}

/** Called by bill.service when a bill is generated by STAFF. */
async function onBillGenerated(businessId, user, bill) {
  try {
    if (!bill || (user && user.isGuestActor)) return;
    const ctx = await C.getContext(businessId);
    if (ctx.ops.printsBill) await queueBillPrint(businessId, bill._id, { mode: 'BILL', ctx });
  } catch (e) { console.error('[print] bill print failed:', e.message); }
}

/** Called by bill.service after a payment. Staff receipts follow the profile; guest M-PESA receipts print whenever a printer exists (as before). */
async function onBillPaid(businessId, bill, user) {
  try {
    if (!bill || bill.status !== 'PAID') return;
    const ctx = await C.getContext(businessId); const plan = ctx.ops; const guest = !!(user && user.isGuestActor);
    if (!plan.configured) { if (guest) await require('../cashier/cashier.service').onGuestBillPaid(businessId, bill); return; }
    const guestMobile = guest && (bill.payments || []).some((p) => (p.kind || 'PAYMENT') === 'PAYMENT' && ['MPESA', 'MOBILE_MONEY'].includes(p.method));
    if (plan.printsReceipt || guestMobile) await queueBillPrint(businessId, bill._id, { mode: 'RECEIPT', ctx });
  } catch (e) { console.error('[print] receipt print failed:', e.message); }
}

/** Manager reprint of a bill or receipt, whatever its state. */
async function reprintBill(businessId, user, billId) {
  const bill = await RestaurantBill.findOne({ _id: billId, businessId }).select('branchId status billNumber').lean();
  if (!bill) throw ApiError.notFound('Bill not found', 'BILL_NOT_FOUND');
  C.assertBranchAccess(user, bill.branchId);
  const ctx = await C.getContext(businessId);
  if (!ctx.ops.route('CASHIER')) throw ApiError.conflict('This restaurant has no printer set up for bills', 'NO_PRINTER');
  const ok = await queueBillPrint(businessId, billId, { mode: bill.status === 'PAID' ? 'RECEIPT' : 'BILL', force: true, ctx });
  if (!ok) throw ApiError.conflict('Could not reach the print queue. Nothing was changed - try again.', 'PRINT_FAILED');
  C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'restaurant.bill.reprint', entityType: 'RestaurantBill', entityId: billId, newValue: { bill: bill.billNumber } }).catch(() => {});
  return { queued: true };
}

/** One paid receipt per bill: the guest-payment path and the cashier dashboard may both ask, the second request is a no-op. `force` = an explicit reprint. (Older callers.) */
async function enqueueReceipt(businessId, branchId, doc, refId, title, { force = false } = {}) {
  try {
    const ctx = await C.getContext(businessId); const target = ctx.ops.route('CASHIER'); if (!target) return;
    if (!force && refId && await PrintJob.exists({ businessId, kind: 'RECEIPT', refId, title: /^Receipt / })) return;
    const copies = ctx.ops.configured ? ctx.ops.print.receiptCopies : 1;
    for (let n = 1; n <= copies; n += 1) await PrintJob.create({ businessId, branchId, target, kind: 'RECEIPT', title: n > 1 ? `${title} (copy ${n})` : title, doc, refId });
  } catch (e) { console.error('[print] could not queue receipt:', e.message); }
}

/** Staff device asks for work. Claims atomically so two devices never print the same ticket; a claim not confirmed in 60 s is offered again. */
async function claim(businessId, user, { targets, branchId, limit = 5 }) {
  C.assertBranchAccess(user, branchId);
  if (!C.can(user, 'restaurant.kitchen.view') && !C.can(user, 'restaurant.bills.view') && !C.can(user, 'restaurant.orders.create')) throw ApiError.forbidden('Printing needs permission', 'FORBIDDEN');
  const want = String(targets || '').split(',').filter((t) => TARGETS.includes(t));
  if (!want.length) return [];
  const out = [];
  for (let i = 0; i < Math.min(+limit || 5, 10); i += 1) {
    const stale = new Date(Date.now() - 60000);
    const j = await PrintJob.findOneAndUpdate({ businessId, branchId, target: { $in: want }, $or: [{ status: 'PENDING' }, { status: 'CLAIMED', claimedAt: { $lt: stale } }] }, { $set: { status: 'CLAIMED', claimedAt: new Date() } }, { sort: { createdAt: 1 }, new: true });
    if (!j) break; out.push(j);
  }
  return out;
}
async function ack(businessId, user, id) {
  const j = await PrintJob.findOneAndUpdate({ _id: id, businessId }, { $set: { status: 'PRINTED', printedAt: new Date() } }, { new: true });
  return { id, status: j ? j.status : 'GONE' };
}

/** For the setup page: is anybody collecting the paper? A job waiting more than 2 minutes means the printer device is off or not in auto-print. */
async function queueHealth(businessId, branchId) {
  const f = { businessId, status: { $in: ['PENDING', 'CLAIMED'] }, ...(branchId ? { branchId } : {}) };
  const rows = await PrintJob.aggregate([{ $match: f }, { $group: { _id: '$target', pending: { $sum: 1 }, oldest: { $min: '$createdAt' } } }]);
  const out = {}; for (const r of rows) out[r._id] = { pending: r.pending, oldestMinutes: Math.floor((Date.now() - new Date(r.oldest).getTime()) / 60000) };
  return out;
}

module.exports = { enqueueKot, enqueueOrderKot, enqueueCancelSlip, enqueueReceipt, queueBillPrint, onBillGenerated, onBillPaid, reprintOrderKot, reprintBill, claim, ack, queueHealth, TARGETS };
