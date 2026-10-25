/**
 * Payment on delivery, taken by the rider at the customer's door.
 *
 *  M-PESA  the rider presses "Request M-Pesa" -> an STK prompt goes to the CUSTOMER's phone -> when it succeeds the server pays the bill
 *          by itself (no human, no cash) and everybody is told. Works even if the rider's phone dies right after.
 *  CASH    the rider presses "I received cash" -> a RiderCollection (HELD) is recorded and the cashier + manager are notified at once ->
 *          back at the restaurant the CASHIER counts it: that pays the bill as CASH into the cashier's own shift (so the drawer, the
 *          receipt, the sale and eTIMS all behave exactly like a normal till payment). A shortage is booked against the rider, never the cashier.
 *
 * Amounts are integer cents everywhere in here; views convert to KES.
 */
const RiderCollection = require('../../models/RiderCollection');
const RiderHandover = require('../../models/RiderHandover');
const RestaurantBill = require('../../models/RestaurantBill');
const RestaurantOrder = require('../../models/RestaurantOrder');
const MpesaTransaction = require('../../models/MpesaTransaction');
const IntegrationSettings = require('../../models/IntegrationSettings');
const CashShift = require('../../models/CashShift');
const StoreBooking = require('../../models/StoreBooking');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const S = require('../../utils/storefront');
const { COLLECTION_ACTIVE } = require('../../constants/rider');
const hub = require('./realtime.hub');
const tracking = require('./tracking.service');
const bills = require('../restaurant/bill.service');
const mpesa = require('../mpesa.service');
const GC = require('../hospitality/common');
const C = require('../restaurant/common');

const { money } = tracking;
const OPEN_BILL = ['OPEN', 'PARTIAL'];
const sid = (v) => (v ? String(v) : '');
const kes = (c) => `KSh ${money(c).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
const mask = (p) => (p ? `${String(p).slice(0, 6)}***${String(p).slice(-3)}` : null);

async function mpesaOn(businessId) {
  const m = await IntegrationSettings.findOne({ businessId }).select('mpesa.enabled mpesa.channelId').lean();
  return !!(m && m.mpesa && m.mpesa.enabled && m.mpesa.channelId);
}
/** The order must be one of THIS rider's deliveries, still on the road. Managers may act for a rider. */
async function loadForRider(businessId, user, orderId, { needLive = true } = {}) {
  const order = await C.loadOrder(businessId, orderId); C.assertBranchAccess(user, order.branchId);
  if (order.orderType !== 'DELIVERY') throw ApiError.badRequest('Not a delivery order', 'NOT_DELIVERY');
  if (!C.sameId(order.delivery.riderId, user._id) && !C.can(user, 'restaurant.delivery.manage')) throw ApiError.forbidden('This delivery is not yours', 'PERMISSION_DENIED');
  if (order.status !== 'OPEN') throw ApiError.conflict(`Order is ${order.status}`, 'ORDER_NOT_OPEN');
  if (needLive && order.delivery.status !== 'OUT_FOR_DELIVERY') throw ApiError.conflict('Start the delivery first. Payment is taken when you are on the way or at the customer.', 'INVALID_DELIVERY_STATE');
  return order;
}

// ------------------------------------------------------------------ what is owed and what is already settled
/** Generates / refreshes the bill with the guest actor (a rider has no bill permission). Everything already billed is simply left alone. */
async function ensureBills(businessId, order) {
  const actor = await GC.guestActor(businessId);
  try { await bills.generateBill(businessId, actor, order._id, {}); } catch (e) { if (!/NOTHING_TO_BILL/.test(e.code || e.message || '')) throw e; }
  return RestaurantBill.find({ businessId, orderId: order._id, status: { $in: OPEN_BILL } }).sort({ createdAt: 1 });
}
const sumBalance = (list) => list.reduce((s, b) => s + (b.balance || 0), 0);

/** UNPAID | AWAITING_MPESA | CASH_HELD | PAID, with the live collection and the amount still to take. Also clears an M-PESA prompt that failed or timed out. */
async function paymentState(order) {
  const businessId = order.businessId;
  const [sb, list, coll] = await Promise.all([
    StoreBooking.findOne({ businessId, kind: 'ORDER', refId: order._id }).select('payState').lean(),
    RestaurantBill.find({ businessId, orderId: order._id, status: { $ne: 'VOID' } }).select('status balance').lean(),
    RiderCollection.findOne({ businessId, orderId: order._id, status: { $in: ['AWAITING_MPESA', ...COLLECTION_ACTIVE] } }),
  ]);
  const base = { prepaid: !!sb && sb.payState === 'PAID' && !coll, collection: coll || null };
  if (coll && coll.status === 'AWAITING_MPESA') {
    const txn = coll.mpesaReference ? await MpesaTransaction.findOne({ businessId, reference: coll.mpesaReference }).select('status createdAt').lean() : null;
    const dead = !txn || ['FAILED', 'CANCELLED'].includes(txn.status) || (txn.status === 'PENDING' && Date.now() - new Date(txn.createdAt).getTime() > 3 * 60000);
    if (!dead) return { ...base, state: 'AWAITING_MPESA', amountDue: coll.amount };
    await RiderCollection.updateOne({ _id: coll._id, status: 'AWAITING_MPESA' }, { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'M-PESA prompt not completed' } });
    base.collection = null;
  } else if (coll && coll.status === 'HELD') return { ...base, state: 'CASH_HELD', amountDue: 0 };
  else if (coll) return { ...base, state: 'PAID', amountDue: 0 };
  if (base.prepaid || (list.length && list.every((b) => ['PAID', 'WRITTEN_OFF'].includes(b.status)))) return { ...base, state: 'PAID', amountDue: 0 };
  const open = list.filter((b) => OPEN_BILL.includes(b.status));
  return { ...base, state: 'UNPAID', amountDue: open.length ? sumBalance(open) : (order.totals && order.totals.total) || 0 };
}

const collectionView = (c) => c && ({ id: c._id, method: c.method, status: c.status, amount: money(c.amount), tendered: money(c.tendered), change: money(c.change), reference: c.mpesaReference || null, receipt: c.mpesaReceipt || null, collectedAt: c.collectedAt, returningAt: c.returningAt || null, handedOverAt: c.handedOverAt || null });

/** The rider's "Payment" screen: what is owed, which methods are on offer, what has been taken. */
async function summary(businessId, user, orderId) {
  const order = await loadForRider(businessId, user, orderId, { needLive: false });
  const { rider: rs } = await tracking.riderSettings(businessId); const mp = await mpesaOn(businessId);
  const st = await paymentState(order); const d = order.delivery;
  const phone = S.kePhone(d.phone || order.customerPhone);
  const options = [];
  if (rs.allowMpesa !== false) options.push({ method: 'MPESA', label: 'M-Pesa (Customer Pays)', hint: 'Request payment from customer', enabled: mp, disabledReason: mp ? null : 'M-PESA is not set up for this business' });
  if (rs.allowCash !== false) options.push({ method: 'CASH', label: 'Cash (Customer Pays)', hint: 'Collect cash from customer', enabled: true });
  return {
    orderId: order._id, orderNumber: order.orderNumber, currency: 'KES', state: st.state, required: st.state === 'UNPAID', amountDue: money(st.amountDue),
    orderPayment: st.prepaid ? 'PREPAID' : 'PAY_ON_DELIVERY', customer: { name: d.contactName || order.customerName, phone: d.phone || order.customerPhone, mpesaPhone: phone ? `+${phone}` : null },
    options, collection: collectionView(st.collection),
    message: ({ UNPAID: 'Collect payment from the customer.', AWAITING_MPESA: 'Waiting for the customer to enter their M-PESA PIN.', CASH_HELD: 'Cash received. Keep it safe and hand it to the cashier at the restaurant.', PAID: st.prepaid ? 'Already paid online. Nothing to collect.' : 'Payment confirmed.' })[st.state],
  };
}

/** Called by order.service before a rider may mark DELIVERED. Managers / owners are never blocked. */
async function assertCanDeliver(order, user) {
  if (user && C.can(user, 'restaurant.delivery.manage')) return;
  const { rider: rs } = await tracking.riderSettings(order.businessId);
  if (rs.requirePaymentBeforeDelivered === false) return;
  const st = await paymentState(order);
  if (st.state === 'UNPAID' || st.state === 'AWAITING_MPESA') throw ApiError.conflict(st.state === 'UNPAID' ? 'Collect the payment from the customer before completing the delivery.' : 'The M-PESA payment has not gone through yet.', 'PAYMENT_NOT_COLLECTED');
}

// ------------------------------------------------------------------ M-PESA prompt to the customer
async function startMpesa(businessId, user, orderId, { phone } = {}) {
  const order = await loadForRider(businessId, user, orderId);
  const { rider: rs } = await tracking.riderSettings(businessId);
  if (rs.allowMpesa === false) throw ApiError.forbidden('M-PESA collection is switched off for riders.', 'MPESA_NOT_ALLOWED');
  if (!(await mpesaOn(businessId))) throw ApiError.badRequest('M-PESA is not set up for this business. Take cash instead.', 'MPESA_NOT_ENABLED');
  const st = await paymentState(order);
  if (st.state === 'PAID') throw ApiError.conflict('This order is already paid.', 'ALREADY_PAID');
  if (st.state === 'CASH_HELD') throw ApiError.conflict('Cash was already collected for this order.', 'ALREADY_COLLECTED');
  const ph = S.kePhone(phone || order.delivery.phone || order.customerPhone);
  if (!ph) throw ApiError.badRequest('Enter a valid Safaricom number, for example 0712 345 678', 'INVALID_PHONE');
  const list = await ensureBills(businessId, order); const amount = sumBalance(list);
  if (!(amount > 0)) throw ApiError.conflict('Nothing is due on this order.', 'NOTHING_TO_PAY');
  const again = await MpesaTransaction.findOne({ businessId, 'riderPay.orderId': order._id, status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 90000) } });
  if (again && again.amount === amount) return { reference: again.reference, amount: money(amount), phone: mask(ph), reused: true };
  const txn = await mpesa.initiateStk(businessId, order.branchId, user, { phone: ph, amountCents: amount, customerName: order.delivery.contactName || order.customerName || 'Customer' });
  const col = await RiderCollection.findOneAndUpdate({ businessId, orderId: order._id, status: 'AWAITING_MPESA' },
    { $set: { branchId: order.branchId, orderNumber: order.orderNumber, riderId: user._id, riderName: user.name, customerName: order.delivery.contactName || order.customerName, customerPhone: ph, method: 'MPESA', amount, bills: list.map((b) => ({ billId: b._id, amount: b.balance })), mpesaReference: txn.reference } },
    { upsert: true, new: true, setDefaultsOnInsert: true });
  await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { riderPay: { orderId: order._id, riderId: user._id, collectionId: col._id, tries: 0 } } });
  tracking.emit(order, 'payment', { event: 'MPESA_REQUESTED', amount: money(amount), branchIds: [order.branchId] });
  return { reference: txn.reference, amount: money(amount), phone: mask(ph), collectionId: col._id };
}

/** The rider's phone polls this while the customer enters their PIN. Settling here too means it works even if the callback is late. */
async function mpesaStatus(businessId, user, reference) {
  const txn = await MpesaTransaction.findOne({ businessId, reference, 'riderPay.orderId': { $exists: true } });
  if (!txn) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  if (!C.sameId(txn.riderPay.riderId, user._id) && !C.can(user, 'restaurant.delivery.manage')) throw ApiError.forbidden('This payment is not yours', 'PERMISSION_DENIED');
  const s = await mpesa.getStatus(businessId, reference);
  const fresh = await MpesaTransaction.findById(txn._id);
  if (fresh.status === 'SUCCESS') await finalize(fresh);
  const done = await MpesaTransaction.findById(txn._id).select('riderPay').lean();
  return { status: s.status, message: s.message, receipt: s.mpesaReceiptNumber || null, reference, settled: !!(done.riderPay && done.riderPay.settledAt), failureType: s.failureType || null };
}

/** Pays the bill from a successful rider STK. Idempotent: a duplicate callback or a poll racing the callback does it once. */
async function finalize(txn) {
  const stale = new Date(Date.now() - 90000);
  const got = await MpesaTransaction.findOneAndUpdate(
    { _id: txn._id, status: 'SUCCESS', 'riderPay.orderId': { $ne: null }, 'riderPay.settledAt': null, $or: [{ 'riderPay.settleStartedAt': null }, { 'riderPay.settleStartedAt': { $lt: stale } }] },
    { $set: { 'riderPay.settleStartedAt': new Date() }, $inc: { 'riderPay.tries': 1 } }, { new: true });
  if (!got) return { settled: false };
  const businessId = got.businessId; const g = got.riderPay;
  const problem = async (msg) => {
    await MpesaTransaction.updateOne({ _id: got._id }, { $set: { 'riderPay.settledAt': new Date(), 'riderPay.error': msg.slice(0, 200) } });
    C.notifyManagement(businessId, { type: 'GUEST_PAYMENT_PROBLEM', title: 'Check a delivery M-PESA payment', message: `${msg} M-PESA ${got.mpesaReceiptNumber || got.reference} (${kes(got.amount)}).`, branchId: got.branchId, entityType: 'MpesaTransaction', entityId: got._id });
    return { settled: false, problem: msg };
  };
  try {
    const order = await RestaurantOrder.findById(g.orderId); if (!order) return await problem('The delivery order no longer exists.');
    const held = await RiderCollection.findOne({ businessId, orderId: order._id, status: 'HELD' });
    if (held) return await problem(`The rider also took cash for ${order.orderNumber}. Refund the customer or the cash.`);
    const actor = await GC.guestActor(businessId); const list = await ensureBills(businessId, order);
    if (!list.length) return await problem(`Order ${order.orderNumber} was already paid another way.`);
    if (list.length !== 1 || list[0].balance !== got.amount) return await problem(`The amount paid (${kes(got.amount)}) does not match what is owed on ${order.orderNumber} (${kes(sumBalance(list))}).`);
    await bills.pay(businessId, actor, list[0]._id, { payments: [{ method: 'MPESA', amount: got.amount, reference: got.reference }] });
    await RiderCollection.findOneAndUpdate({ businessId, orderId: order._id, status: { $in: ['AWAITING_MPESA', 'CANCELLED'] } },
      { $set: { status: 'PAID', method: 'MPESA', amount: got.amount, branchId: order.branchId, orderNumber: order.orderNumber, riderId: g.riderId, riderName: order.delivery.riderName, customerName: order.delivery.contactName || order.customerName, customerPhone: got.phone, mpesaReference: got.reference, mpesaReceipt: got.mpesaReceiptNumber, collectedAt: new Date(), bills: [{ billId: list[0]._id, amount: got.amount }] }, $unset: { cancelledAt: 1, cancelReason: 1 } },
      { upsert: true });
    await MpesaTransaction.updateOne({ _id: got._id }, { $set: { 'riderPay.settledAt': new Date() }, $unset: { 'riderPay.error': 1 } });
    after(order, got.amount, 'MPESA', got.mpesaReceiptNumber);
    return { settled: true };
  } catch (e) {
    await MpesaTransaction.updateOne({ _id: got._id }, { $set: { 'riderPay.error': String(e.message).slice(0, 200) } });
    logger.warn('rider M-PESA settle failed', { error: e.message });
    return { settled: false, error: e.message };
  }
}
const finalizeByTxn = async (id) => { try { const t = await MpesaTransaction.findById(id); if (t && t.status === 'SUCCESS' && t.riderPay && t.riderPay.orderId) return await finalize(t); } catch (e) { logger.warn('rider finalizeByTxn failed', { error: e.message }); } return null; };

/** Everybody who needs to know that the money is in. */
async function after(order, amount, method, ref) {
  try {
    const d = order.delivery;
    await tracking.addAlert(order, 'PAYMENT', `Payment of ${kes(amount)} received${method === 'MPESA' ? ' by M-PESA' : ' in cash'}. Thank you!`, { title: 'Payment received' });
    tracking.emit(order, 'payment', { event: method === 'MPESA' ? 'MPESA_PAID' : 'CASH_COLLECTED', amount: money(amount), riderId: d.riderId, branchIds: [order.branchId] });
    if (d.riderId) {
      hub.publish(hub.ch.user(d.riderId), 'payment', { orderId: order._id, orderNumber: order.orderNumber, method, amount: money(amount), receipt: ref || null });
      if (method === 'MPESA') C.notifyUser(order.businessId, d.riderId, { type: 'RIDER_PAYMENT_RECEIVED', title: `Payment received ${order.orderNumber}`, message: `${kes(amount)} paid by M-PESA${ref ? ` (${ref})` : ''}. You can complete the delivery.`, branchId: order.branchId, entityType: 'RestaurantOrder', entityId: order._id });
    }
    if (method === 'MPESA') await tracking.notifyStaff(order, tracking.CASHIERS, { type: 'RIDER_PAYMENT_RECEIVED', title: `Delivery paid ${order.orderNumber}`, message: `${d.contactName || order.customerName || 'Customer'} paid ${kes(amount)} by M-PESA${ref ? ` (${ref})` : ''} at the door.` }, { management: false });
  } catch (e) { logger.warn('payment after-hook failed', { error: e.message }); }
}

// ------------------------------------------------------------------ cash taken by the rider
async function collectCash(businessId, user, orderId, { tendered } = {}) {
  const order = await loadForRider(businessId, user, orderId);
  const { rider: rs } = await tracking.riderSettings(businessId);
  if (rs.allowCash === false) throw ApiError.forbidden('Cash collection is switched off for riders.', 'CASH_NOT_ALLOWED');
  const st = await paymentState(order);
  if (st.state === 'PAID') throw ApiError.conflict('This order is already paid.', 'ALREADY_PAID');
  if (st.state === 'CASH_HELD') throw ApiError.conflict('Cash was already collected for this order.', 'ALREADY_COLLECTED');
  if (st.state === 'AWAITING_MPESA') throw ApiError.conflict('An M-PESA prompt is still active. Wait for it to finish (about a minute) or ask the customer to cancel it.', 'MPESA_IN_PROGRESS');
  const list = await ensureBills(businessId, order); const amount = sumBalance(list);
  if (!(amount > 0)) throw ApiError.conflict('Nothing is due on this order.', 'NOTHING_TO_PAY');
  const given = tendered === undefined || tendered === null ? amount : tendered;
  if (given < amount) throw ApiError.badRequest(`The customer gave less than ${kes(amount)}.`, 'TENDERED_TOO_LOW');
  let col;
  try {
    col = await RiderCollection.create({ businessId, branchId: order.branchId, orderId: order._id, orderNumber: order.orderNumber, riderId: user._id, riderName: user.name, customerName: order.delivery.contactName || order.customerName, customerPhone: order.delivery.phone || order.customerPhone, method: 'CASH', status: 'HELD', amount, tendered: given, change: given - amount, bills: list.map((b) => ({ billId: b._id, amount: b.balance })), collectedAt: new Date() });
  } catch (e) { if (e.code === 11000) throw ApiError.conflict('Cash was already collected for this order.', 'ALREADY_COLLECTED'); throw e; }
  C.audit({ businessId, branchId: order.branchId, userId: user._id, action: 'restaurant.delivery.cash_collected', entityType: 'RiderCollection', entityId: col._id, newValue: { orderNumber: order.orderNumber, amount } }).catch(() => {});
  await after(order, amount, 'CASH');
  await tracking.notifyStaff(order, tracking.CASHIERS, { type: 'RIDER_CASH_COLLECTED', title: `Cash collected ${kes(amount)}`, message: `${user.name} took ${kes(amount)} cash for ${order.orderNumber} from ${order.delivery.contactName || order.customerName || 'the customer'}. Expect it at the till.` });
  hub.publish(hub.ch.biz(businessId), 'cash', { event: 'COLLECTED', riderId: user._id, riderName: user.name, orderNumber: order.orderNumber, amount: money(amount), branchId: order.branchId });
  return collectionView(col);
}

/** "Proceed to restaurant": tells the cashier the rider is coming back with cash. */
async function returning(businessId, user) {
  const held = await RiderCollection.find({ businessId, riderId: user._id, status: 'HELD' });
  if (!held.length) return { count: 0, total: 0 };
  const total = held.reduce((s, c) => s + c.amount, 0); const now = new Date();
  const fresh = held.filter((c) => !c.returningAt);
  await RiderCollection.updateMany({ _id: { $in: held.map((c) => c._id) }, returningAt: { $exists: false } }, { $set: { returningAt: now } });
  if (fresh.length) {
    const branchId = held[0].branchId;
    await C.notifyRoles(businessId, branchId, tracking.CASHIERS.filter((r) => r !== 'MANAGER'), { type: 'RIDER_CASH_RETURNING', title: `${user.name} is bringing ${kes(total)}`, message: `${held.length} order(s): ${held.map((c) => c.orderNumber).join(', ')}. Have your shift open to receive it.`, entityType: 'User', entityId: user._id });
    hub.publish(hub.ch.biz(businessId), 'cash', { event: 'RETURNING', riderId: user._id, riderName: user.name, total: money(total), count: held.length, branchId });
  }
  return { count: held.length, total: money(total) };
}

async function wallet(businessId, user) {
  const [held, recent, today] = await Promise.all([
    RiderCollection.find({ businessId, riderId: user._id, status: 'HELD' }).sort({ collectedAt: 1 }).lean(),
    RiderHandover.find({ businessId, riderId: user._id }).sort({ createdAt: -1 }).limit(15).lean(),
    RiderCollection.find({ businessId, riderId: user._id, collectedAt: { $gte: new Date(Date.now() - 24 * 3600000) }, status: { $in: COLLECTION_ACTIVE } }).select('method amount').lean(),
  ]);
  const sum = (a) => a.reduce((s, c) => s + c.amount, 0);
  return {
    cashHeld: money(sum(held)), count: held.length, oldestAt: held[0] ? held[0].collectedAt : null,
    collections: held.map((c) => ({ ...collectionView(c), orderNumber: c.orderNumber, customerName: c.customerName })),
    last24h: { cash: money(sum(today.filter((c) => c.method === 'CASH'))), mpesa: money(sum(today.filter((c) => c.method === 'MPESA'))), count: today.length },
    handovers: recent.map((h) => ({ id: h._id, at: h.createdAt, expected: money(h.expected), received: money(h.received), variance: money(h.variance), cashier: h.cashierName, orders: h.orderNumbers })),
  };
}

// ------------------------------------------------------------------ cashier / manager: count a rider's cash
const minutes = (d) => Math.round((Date.now() - new Date(d).getTime()) / 60000);
async function heldByRider(businessId, user, { branchId } = {}) {
  C.requireCan(user, 'restaurant.delivery.cash', 'Receiving rider cash needs permission');
  const scope = C.branchScope(user, branchId);
  const list = await RiderCollection.find({ businessId, status: 'HELD', ...C.branchFilter(scope) }).sort({ collectedAt: 1 }).lean();
  const groups = new Map();
  for (const c of list) {
    const g = groups.get(sid(c.riderId)) || { rider: { id: c.riderId, name: c.riderName }, total: 0, count: 0, returning: false, oldestMinutes: 0, collections: [] };
    g.total += c.amount; g.count += 1; g.returning = g.returning || !!c.returningAt; g.oldestMinutes = Math.max(g.oldestMinutes, minutes(c.collectedAt));
    g.collections.push({ id: c._id, orderNumber: c.orderNumber, customerName: c.customerName, amount: money(c.amount), collectedAt: c.collectedAt, heldMinutes: minutes(c.collectedAt), branchId: c.branchId });
    groups.set(sid(c.riderId), g);
  }
  const riders = [...groups.values()].map((g) => ({ ...g, total: money(g.total) })).sort((a, b) => Number(b.returning) - Number(a.returning) || b.oldestMinutes - a.oldestMinutes);
  return { riders, totalHeld: money(list.reduce((s, c) => s + c.amount, 0)), count: list.length };
}

/**
 * The cashier counted the cash. receivedAmount (cents) defaults to the expected total. Every bill is paid as CASH into the cashier's open shift;
 * if the rider is SHORT, the missing part is booked as an "OTHER" payment referenced to the rider, so the till balances and the shortage is traceable.
 */
async function handover(businessId, cashier, { riderId, collectionIds, receivedAmount, note }) {
  C.requireCan(cashier, 'restaurant.delivery.cash', 'Receiving rider cash needs permission');
  const q = { businessId, riderId, status: 'HELD' }; if (collectionIds && collectionIds.length) q._id = { $in: collectionIds };
  const cols = await RiderCollection.find(q).sort({ collectedAt: 1 });
  if (!cols.length) throw ApiError.conflict('This rider has no cash waiting to be handed over.', 'NOTHING_TO_HAND_OVER');
  if (collectionIds && collectionIds.length && cols.length !== new Set(collectionIds.map(String)).size) throw ApiError.conflict('Some of those payments were already handed over. Refresh and try again.', 'ALREADY_HANDED_OVER');
  const branchIds = [...new Set(cols.map((c) => sid(c.branchId)))]; branchIds.forEach((b) => C.assertBranchAccess(cashier, b));
  const ctx = await C.getContext(businessId);
  const needShift = ctx.settings.paymentsRequireShift && ctx.business.settings?.requireShift !== false; let shiftId;
  for (const b of branchIds) {
    const shift = await CashShift.findOne({ businessId, branchId: b, cashierId: cashier._id, status: 'OPEN' }).select('_id');
    if (!shift && needShift) throw ApiError.badRequest('Open your cash shift before receiving the rider’s cash.', 'SHIFT_REQUIRED');
    if (shift && !shiftId) shiftId = shift._id;
  }
  const expected = cols.reduce((s, c) => s + c.amount, 0);
  const received = receivedAmount === undefined || receivedAmount === null ? expected : receivedAmount;
  const variance = received - expected; let short = variance < 0 ? -variance : 0;
  const shortPart = new Map();                                    // how much of each bill is the rider's shortfall (taken from the newest cash first)
  for (const c of [...cols].reverse()) for (const b of [...c.bills].reverse()) { const take = Math.min(b.amount, short); if (take > 0) { shortPart.set(sid(b.billId), take); short -= take; } }

  const done = [];
  try {
    for (const c of cols) {
      for (const entry of c.bills) {
        const bill = await RestaurantBill.findOne({ _id: entry.billId, businessId }); if (!bill) continue;
        if (!OPEN_BILL.includes(bill.status)) continue;           // settled another way meanwhile: nothing to pay, just release the cash record
        const pay = Math.min(entry.amount, bill.balance); const sh = Math.min(shortPart.get(sid(entry.billId)) || 0, pay); const cash = pay - sh;
        const payments = [];
        if (cash > 0) payments.push({ method: 'CASH', amount: cash, tendered: cash });
        if (sh > 0) payments.push({ method: 'OTHER', amount: sh, reference: `RIDER-SHORT:${c.riderName || riderId}` });
        await bills.pay(businessId, cashier, bill._id, { payments });
      }
      await RiderCollection.updateOne({ _id: c._id, status: 'HELD' }, { $set: { status: 'HANDED_OVER', handedOverAt: new Date(), handoverBy: cashier._id } });
      done.push(c);
    }
  } catch (e) {
    if (done.length) await finishHandover(businessId, cashier, cols[0], done, { received: done.reduce((s, c) => s + c.amount, 0), variance: 0, note: `Partly recorded before an error: ${e.message}`, shiftId });
    throw ApiError.conflict(done.length ? `${done.length} of ${cols.length} payments were recorded, then: ${e.message}. Refresh and handle the rest.` : e.message, e.code || 'HANDOVER_FAILED');
  }
  return finishHandover(businessId, cashier, cols[0], done, { received, variance, note, shiftId });
}

async function finishHandover(businessId, cashier, first, done, { received, variance, note, shiftId }) {
  const expected = done.reduce((s, c) => s + c.amount, 0);
  const h = await RiderHandover.create({ businessId, branchId: first.branchId, riderId: first.riderId, riderName: first.riderName, cashierId: cashier._id, cashierName: cashier.name, shiftId, collectionIds: done.map((c) => c._id), orderNumbers: done.map((c) => c.orderNumber), expected, received, variance, note });
  await RiderCollection.updateMany({ _id: { $in: done.map((c) => c._id) } }, { $set: { handoverId: h._id } });
  C.audit({ businessId, branchId: first.branchId, userId: cashier._id, action: 'restaurant.delivery.cash_handover', entityType: 'RiderHandover', entityId: h._id, newValue: { rider: first.riderName, expected, received, variance } }).catch(() => {});
  C.notifyUser(businessId, first.riderId, { type: 'RIDER_CASH_HANDOVER', title: 'Cash received', message: `${cashier.name} received ${kes(received)} from you for ${done.length} order(s).${variance ? ` Difference: ${variance < 0 ? '-' : '+'}${kes(Math.abs(variance))}.` : ''}`, branchId: first.branchId, entityType: 'RiderHandover', entityId: h._id });
  if (variance !== 0) C.notifyManagement(businessId, { type: 'RIDER_CASH_SHORT', title: variance < 0 ? `Rider cash SHORT ${kes(-variance)}` : `Rider cash over ${kes(variance)}`, message: `${first.riderName} handed ${kes(received)} to ${cashier.name}; expected ${kes(expected)} (${done.map((c) => c.orderNumber).join(', ')}).${note ? ` Note: ${note}` : ''}`, branchId: first.branchId, entityType: 'RiderHandover', entityId: h._id, severity: variance < 0 ? 'critical' : 'warning' });
  else C.notifyManagement(businessId, { type: 'RIDER_CASH_HANDOVER', title: `Cash handed over ${kes(received)}`, message: `${first.riderName} handed ${kes(received)} to ${cashier.name} (${done.length} order(s)).`, branchId: first.branchId, entityType: 'RiderHandover', entityId: h._id });
  hub.publish(hub.ch.biz(businessId), 'cash', { event: 'HANDED_OVER', riderId: first.riderId, riderName: first.riderName, received: money(received), variance: money(variance), branchId: first.branchId });
  return { id: h._id, rider: first.riderName, orders: done.map((c) => c.orderNumber), expected: money(expected), received: money(received), variance: money(variance), at: h.createdAt };
}

async function handoverHistory(businessId, user, { branchId, riderId, page = 1, limit = 20 }) {
  C.requireCan(user, 'restaurant.delivery.cash', 'Viewing rider cash needs permission');
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)), ...(riderId ? { riderId } : {}) };
  const [items, total] = await Promise.all([RiderHandover.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), RiderHandover.countDocuments(f)]);
  return C.paged(items.map((h) => ({ id: h._id, at: h.createdAt, rider: h.riderName, cashier: h.cashierName, orders: h.orderNumbers, expected: money(h.expected), received: money(h.received), variance: money(h.variance), note: h.note })), total, { page, limit });
}

// ------------------------------------------------------------------ background (jobs/rider.job.js)
async function sweep() {
  const todo = await MpesaTransaction.find({ 'riderPay.orderId': { $ne: null }, 'riderPay.settledAt': null, status: 'SUCCESS', 'riderPay.tries': { $lt: 6 }, createdAt: { $gt: new Date(Date.now() - 6 * 3600000) } }).limit(30);
  for (const t of todo) await finalize(t);
  const { DEFAULTS } = require('../../constants/rider');
  const old = await RiderCollection.find({ status: 'HELD', collectedAt: { $lt: new Date(Date.now() - DEFAULTS.cashHeldWarnHours * 3600000) }, remindedAt: { $exists: false } }).limit(100);
  for (const c of old) {
    const got = await RiderCollection.updateOne({ _id: c._id, remindedAt: { $exists: false } }, { $set: { remindedAt: new Date() } });
    if (got.modifiedCount === 1) C.notifyManagement(c.businessId, { type: 'RIDER_CASH_OVERDUE', title: `${c.riderName} still holds ${kes(c.amount)}`, message: `Cash for ${c.orderNumber} was collected over ${DEFAULTS.cashHeldWarnHours} hours ago and has not been handed to the cashier.`, branchId: c.branchId, entityType: 'RiderCollection', entityId: c._id });
  }
}

module.exports = { summary, assertCanDeliver, paymentState, startMpesa, mpesaStatus, finalizeByTxn, collectCash, returning, wallet, heldByRider, handover, handoverHistory, sweep };