/**
 * Everything the rider's phone shows: dashboard, "My Deliveries", order details, the delivery steps, wallet and profile.
 * The steps reuse order.service.setDeliveryStatus (so the kitchen, the bill and the order-closing rules stay in ONE place) and add
 * the rider-only extras (picked up, arrived, payment-before-delivered) around it.
 */
const RestaurantOrder = require('../../models/RestaurantOrder');
const RiderPresence = require('../../models/RiderPresence');
const Branch = require('../../models/Branch');
const User = require('../../models/User');
const ApiError = require('../../utils/ApiError');
const geo = require('../../utils/geo');
const S = require('../../utils/storefront');
const { localParts } = require('../../utils/restaurantTime');
const { DEFAULTS } = require('../../constants/rider');
const orders = require('../restaurant/order.service');
const tracking = require('./tracking.service');
const payments = require('./delivery-payment.service');
const C = require('../restaurant/common');

const { money } = tracking;
const sid = (v) => (v ? String(v) : '');
const mine = (user) => ({ 'delivery.riderId': user._id });
const navUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
const STAGE_LABEL = { PENDING: 'Pending', ASSIGNED: 'Assigned', PICKED_UP: 'Picked up', ON_THE_WAY: 'On the way', ARRIVED: 'Arrived', DELIVERED: 'Delivered', FAILED: 'Failed', CANCELLED: 'Cancelled' };
const startOfToday = (tz) => S.zonedDate(localParts(new Date(), tz).date, '00:00', tz);

/** One line of "My Deliveries". */
function row(o, here) {
  const d = o.delivery || {}; const t = d.tracking || {}; const stage = tracking.stageOf(o); const tgt = tracking.targetOf(o);
  const live = stage === 'ON_THE_WAY' || stage === 'ARRIVED';
  const distanceKm = live && t.distanceM != null ? Math.round(t.distanceM / 100) / 10 : here && tgt ? Math.round(geo.distanceM(here, tgt) / 100) / 10 : d.distanceKm ?? null;
  return {
    orderId: o._id, orderNumber: o.orderNumber, stage, label: STAGE_LABEL[stage], total: money(o.totals && o.totals.total), distanceKm,
    address: d.address, landmark: d.landmark, customerName: d.contactName || o.customerName, placedAt: o.createdAt, etaMinutes: live ? t.etaMinutes ?? d.etaMinutes ?? null : d.etaMinutes ?? null,
    payment: { method: d.payment || 'CASH' }, readyForPickup: (o.items || []).some((i) => ['READY', 'SERVED'].includes(i.status)),
  };
}
const ROW_SELECT = 'orderNumber status branchId items.status customerName customerPhone totals delivery createdAt';

async function hereOf(businessId, user) {
  const p = await RiderPresence.findOne({ businessId, riderId: user._id }).select('location lastSeenAt').lean();
  return p && p.location && geo.validPoint(p.location) && Date.now() - new Date(p.lastSeenAt).getTime() < 5 * 60000 ? { lat: p.location.lat, lng: p.location.lng } : null;
}

async function ratingOf(businessId, riderId) {
  const [r] = await RestaurantOrder.aggregate([{ $match: { businessId: C.oid(businessId), 'delivery.riderId': C.oid(riderId), 'delivery.rating.stars': { $exists: true } } }, { $group: { _id: null, avg: { $avg: '$delivery.rating.stars' }, count: { $sum: 1 } } }]);
  return r ? { average: Math.round(r.avg * 10) / 10, count: r.count } : { average: null, count: 0 };
}

// ------------------------------------------------------------------ dashboard / profile
async function dashboard(businessId, user) {
  const ctx = await C.getContext(businessId); const since = startOfToday(ctx.timeZone); const here = await hereOf(businessId, user);
  const [active, doneToday, presence, wallet] = await Promise.all([
    RestaurantOrder.find({ businessId, orderType: 'DELIVERY', status: 'OPEN', ...mine(user), 'delivery.status': { $in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } }).select(ROW_SELECT).sort({ 'delivery.assignedAt': 1 }).lean(),
    RestaurantOrder.countDocuments({ businessId, orderType: 'DELIVERY', ...mine(user), 'delivery.status': 'DELIVERED', 'delivery.deliveredAt': { $gte: since } }),
    RiderPresence.findOne({ businessId, riderId: user._id }).lean(),
    payments.wallet(businessId, user),
  ]);
  const inProgress = active.filter((o) => o.delivery.status === 'OUT_FOR_DELIVERY').length;
  const p = tracking.presenceView(presence);
  return {
    greeting: { name: user.name, firstName: tracking.firstName(user.name) },
    online: !!(p && p.online), presence: p,
    counts: { assigned: active.length - inProgress, inProgress, completed: doneToday, total: active.length + doneToday },
    deliveries: active.map((o) => row(o, here)), cashHeld: wallet.cashHeld, cashHeldCount: wallet.count,
    serverTime: new Date(),
  };
}

async function me(businessId, user) {
  const u = await User.findById(user._id).select('name phone email employeeCode branchIds createdAt').lean();
  const branches = await Branch.find({ _id: { $in: u.branchIds || [] } }).select('name').lean();
  const [rating, wallet, presence] = await Promise.all([ratingOf(businessId, user._id), payments.wallet(businessId, user), RiderPresence.findOne({ businessId, riderId: user._id }).lean()]);
  return { id: u._id, name: u.name, phone: u.phone, email: u.email, employeeCode: u.employeeCode, role: 'Rider', branches: branches.map((b) => ({ id: b._id, name: b.name })), rating, cashHeld: wallet.cashHeld, presence: tracking.presenceView(presence), memberSince: u.createdAt };
}

// ------------------------------------------------------------------ lists
/** tab: 'active' (assigned + on the way) | 'completed' (delivered / failed in the last 14 days). */
async function list(businessId, user, { tab = 'active', page = 1, limit = 20 } = {}) {
  const here = await hereOf(businessId, user);
  const f = tab === 'completed'
    ? { businessId, orderType: 'DELIVERY', ...mine(user), 'delivery.status': { $in: ['DELIVERED', 'FAILED'] }, createdAt: { $gt: new Date(Date.now() - 14 * 86400000) } }
    : { businessId, orderType: 'DELIVERY', status: 'OPEN', ...mine(user), 'delivery.status': { $in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } };
  const [rows, total, counts] = await Promise.all([
    RestaurantOrder.find(f).select(ROW_SELECT).sort(tab === 'completed' ? { 'delivery.deliveredAt': -1, createdAt: -1 } : { 'delivery.assignedAt': 1 }).skip((page - 1) * limit).limit(limit).lean(),
    RestaurantOrder.countDocuments(f),
    Promise.all([
      RestaurantOrder.countDocuments({ businessId, orderType: 'DELIVERY', status: 'OPEN', ...mine(user), 'delivery.status': { $in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } }),
      RestaurantOrder.countDocuments({ businessId, orderType: 'DELIVERY', ...mine(user), 'delivery.status': { $in: ['DELIVERED', 'FAILED'] }, createdAt: { $gt: new Date(Date.now() - 14 * 86400000) } }),
    ]),
  ]);
  return { ...C.paged(rows.map((o) => row(o, here)), total, { page, limit }), tabs: { active: counts[0], completed: counts[1] } };
}

// ------------------------------------------------------------------ one delivery
const FEE_LINE = (i) => !i.menuItemId;
async function detail(businessId, user, orderId) {
  const o = await C.loadOrder(businessId, orderId); C.assertBranchAccess(user, o.branchId);
  if (o.orderType !== 'DELIVERY') throw ApiError.badRequest('Not a delivery order', 'NOT_DELIVERY');
  if (!C.sameId(o.delivery.riderId, user._id) && !C.can(user, 'restaurant.delivery.manage')) throw ApiError.forbidden('This delivery is not yours', 'PERMISSION_DENIED');
  const plain = o.toObject({ transform: false, virtuals: false }); const d = plain.delivery; const stage = tracking.stageOf(plain);
  const cfg = await tracking.riderSettings(businessId); const branch = await Branch.findById(plain.branchId).select('name phone address').lean();
  const live = ['ON_THE_WAY', 'ARRIVED'].includes(stage); const t = d.tracking || {}; const tgt = tracking.targetOf(plain);
  const items = (plain.items || []).filter((i) => i.status !== 'CANCELLED' && !i.parentItemId);
  const bp = (cfg.branchLocations || []).find((x) => sid(x.branchId) === sid(plain.branchId));
  const pay = o.status === 'OPEN' ? await payments.summary(businessId, user, orderId).catch(() => null) : null;
  const ready = items.some((i) => ['READY', 'SERVED'].includes(i.status));
  const can = {
    pickup: stage === 'ASSIGNED' && ready && !d.pickedUpAt,
    start: ['ASSIGNED', 'PICKED_UP'].includes(stage) && ready,
    arrived: stage === 'ON_THE_WAY',
    pay: live && !!pay && ['UNPAID', 'AWAITING_MPESA'].includes(pay.state),
    complete: live && (!pay || !['UNPAID', 'AWAITING_MPESA'].includes(pay.state) || cfg.rider.requirePaymentBeforeDelivered === false),
    fail: live || ['ASSIGNED', 'PICKED_UP'].includes(stage),
  };
  return {
    orderId: plain._id, orderNumber: plain.orderNumber, stage, label: STAGE_LABEL[stage], status: plain.status, placedAt: plain.createdAt, assignedAt: d.assignedAt, pickedUpAt: d.pickedUpAt, outForDeliveryAt: d.outForDeliveryAt, arrivedAt: d.arrivedAt, deliveredAt: d.deliveredAt, failReason: d.failReason,
    ready, can, timeline: tracking.timeline(plain, stage),
    customer: { name: d.contactName || plain.customerName, phone: d.phone || plain.customerPhone, address: d.address, landmark: d.landmark, instructions: d.instructions, notes: plain.notes, lat: tgt ? tgt.lat : d.lat, lng: tgt ? tgt.lng : d.lng, sharedLive: !!(tgt && tgt.live), mapsUrl: tgt ? navUrl(tgt.lat, tgt.lng) : null },
    pickup: { branch: branch ? { id: plain.branchId, name: branch.name, phone: branch.phone, address: branch.address } : null, lat: bp ? bp.lat : null, lng: bp ? bp.lng : null, mapsUrl: bp ? navUrl(bp.lat, bp.lng) : null },
    items: items.filter((i) => !FEE_LINE(i)).map((i) => ({ name: i.name, variant: i.variantName, quantity: i.quantity, total: money(i.total != null ? i.total : (i.unitPrice || 0) * i.quantity), notes: i.notes })),
    deliveryFee: money(d.fee), total: money(plain.totals && plain.totals.total), distanceKm: d.distanceKm ?? null,
    tracking: live ? { distanceM: t.distanceM ?? null, etaMinutes: t.etaMinutes ?? d.etaMinutes ?? null } : null,
    payment: pay ? { state: pay.state, required: pay.required, amountDue: pay.amountDue, orderPayment: pay.orderPayment, methodLabel: pay.orderPayment === 'PREPAID' ? 'Paid online' : 'Pay on Delivery', collection: pay.collection } : null,
    rating: d.rating && d.rating.stars ? d.rating.stars : null,
  };
}

// ------------------------------------------------------------------ steps
async function ownOrder(businessId, user, orderId) {
  const o = await C.loadOrder(businessId, orderId); C.assertBranchAccess(user, o.branchId);
  if (o.orderType !== 'DELIVERY') throw ApiError.badRequest('Not a delivery order', 'NOT_DELIVERY');
  if (!C.sameId(o.delivery.riderId, user._id)) throw ApiError.forbidden('This delivery is not yours', 'PERMISSION_DENIED');
  return o;
}
/** "I have the food." (optional step: Start also does it) */
async function pickup(businessId, user, orderId) {
  const o = await ownOrder(businessId, user, orderId);
  if (o.delivery.status !== 'ASSIGNED') throw ApiError.conflict(`Delivery is ${o.delivery.status}`, 'INVALID_DELIVERY_STATE');
  if (!o.items.some((i) => ['READY', 'SERVED'].includes(i.status))) throw ApiError.conflict('The food is not ready yet', 'ITEMS_NOT_READY');
  const got = await RestaurantOrder.updateOne({ _id: o._id, 'delivery.pickedUpAt': { $exists: false } }, { $set: { 'delivery.pickedUpAt': new Date() } });
  if (got.modifiedCount === 1) tracking.emit(o, 'status', { event: 'PICKED_UP', riderId: user._id, branchIds: [o.branchId] });
  return detail(businessId, user, orderId);
}
async function start(businessId, user, orderId, { lat, lng } = {}) {
  await ownOrder(businessId, user, orderId);
  await orders.setDeliveryStatus(businessId, user, orderId, { status: 'OUT_FOR_DELIVERY' });     // order.service calls tracking.onStatus: customer + cashier are told
  if (geo.validPoint({ lat, lng })) await tracking.ingest(businessId, user, { lat, lng });
  else await tracking.setOnline(businessId, user, true);
  return detail(businessId, user, orderId);
}
async function arrived(businessId, user, orderId, { lat, lng } = {}) {
  await tracking.markArrived(businessId, user, orderId, { lat, lng });
  return detail(businessId, user, orderId);
}
async function complete(businessId, user, orderId) {
  await ownOrder(businessId, user, orderId);
  await orders.setDeliveryStatus(businessId, user, orderId, { status: 'DELIVERED' });            // refuses while payment is outstanding (assertCanDeliver)
  return detail(businessId, user, orderId);
}
async function fail(businessId, user, orderId, { reason }) {
  await ownOrder(businessId, user, orderId);
  const o = await C.loadOrder(businessId, orderId);
  if (o.delivery.status === 'ASSIGNED') {                                                         // never left the restaurant: let a manager reassign (back to the pool)
    await RestaurantOrder.updateOne({ _id: o._id, 'delivery.status': 'ASSIGNED' }, { $set: { 'delivery.status': 'PENDING' }, $unset: { 'delivery.riderId': 1, 'delivery.riderName': 1, 'delivery.riderPhone': 1, 'delivery.assignedAt': 1, 'delivery.pickedUpAt': 1 } });
    await C.notifyManagement(businessId, { type: 'DELIVERY_FAILED', title: `${user.name} returned ${o.orderNumber}`, message: `Rider gave the delivery back${reason ? `: ${reason}` : ''}. Assign another rider.`, branchId: o.branchId, entityType: 'RestaurantOrder', entityId: o._id });
    tracking.emit(o, 'status', { event: 'UNASSIGNED', riderId: user._id, branchIds: [o.branchId] });
    return { ok: true, returnedToPool: true };
  }
  await orders.setDeliveryStatus(businessId, user, orderId, { status: 'FAILED', reason });
  return detail(businessId, user, orderId);
}

// ------------------------------------------------------------------ self-claim (owner switches it on in settings)
async function available(businessId, user) {
  const { rider: rs } = await tracking.riderSettings(businessId);
  if (!rs.selfClaim) return { enabled: false, items: [] };
  const scope = C.branchScope(user, null);
  const rows = await RestaurantOrder.find({ businessId, ...C.branchFilter(scope), orderType: 'DELIVERY', status: 'OPEN', 'delivery.riderId': { $exists: false }, createdAt: { $gt: new Date(Date.now() - 12 * 3600000) } }).select(ROW_SELECT).sort({ createdAt: 1 }).limit(30).lean();
  const here = await hereOf(businessId, user);
  return { enabled: true, items: rows.filter((o) => (o.items || []).some((i) => i.status !== 'DRAFT' && i.status !== 'CANCELLED')).map((o) => row(o, here)) };
}
async function claim(businessId, user, orderId) {
  const { rider: rs } = await tracking.riderSettings(businessId);
  if (!rs.selfClaim) throw ApiError.forbidden('Picking up deliveries yourself is switched off. Ask your manager to assign them.', 'SELF_CLAIM_OFF');
  const o = await C.loadOrder(businessId, orderId); C.assertBranchAccess(user, o.branchId);
  if (o.orderType !== 'DELIVERY' || o.status !== 'OPEN') throw ApiError.conflict('This delivery is not available.', 'NOT_AVAILABLE');
  const u = await User.findById(user._id).select('name phone');
  const got = await RestaurantOrder.findOneAndUpdate({ _id: o._id, status: 'OPEN', 'delivery.riderId': { $exists: false } }, { $set: { 'delivery.riderId': user._id, 'delivery.riderName': u.name, 'delivery.riderPhone': u.phone, 'delivery.status': 'ASSIGNED', 'delivery.assignedAt': new Date() }, $push: { history: { at: new Date(), action: 'delivery.claim', by: user._id, note: u.name } } }, { new: true });
  if (!got) throw ApiError.conflict('Another rider just took this delivery.', 'ALREADY_ASSIGNED');
  await tracking.onAssigned(got, { _id: user._id, name: u.name });
  return detail(businessId, user, orderId);
}

// ------------------------------------------------------------------ earnings
async function earnings(businessId, user, { period = 'today' } = {}) {
  const ctx = await C.getContext(businessId); const { rider: rs } = await tracking.riderSettings(businessId); const pay = rs.pay || { mode: 'NONE' };
  const today = startOfToday(ctx.timeZone); const from = period === 'week' ? new Date(today.getTime() - 6 * 86400000) : period === 'month' ? new Date(today.getTime() - 29 * 86400000) : today;
  const rows = await RestaurantOrder.find({ businessId, orderType: 'DELIVERY', ...mine(user), 'delivery.status': 'DELIVERED', 'delivery.deliveredAt': { $gte: from } }).select('orderNumber delivery.fee delivery.deliveredAt delivery.distanceKm delivery.rating totals.total').sort({ 'delivery.deliveredAt': -1 }).lean();
  const per = (o) => (pay.mode === 'FLAT' ? pay.flatCents || 0 : pay.mode === 'FEE_PERCENT' ? Math.round(((o.delivery.fee || 0) * (pay.feePercent ?? 100)) / 100) : 0);
  const lines = rows.map((o) => ({ orderNumber: o.orderNumber, at: o.delivery.deliveredAt, distanceKm: o.delivery.distanceKm ?? null, deliveryFee: money(o.delivery.fee || 0), earned: money(per(o)), rating: o.delivery.rating && o.delivery.rating.stars ? o.delivery.rating.stars : null }));
  return { period, from, deliveries: rows.length, deliveryFees: money(rows.reduce((s, o) => s + (o.delivery.fee || 0), 0)), earned: money(rows.reduce((s, o) => s + per(o), 0)), mode: pay.mode || 'NONE', lines: lines.slice(0, 100) };
}

module.exports = { dashboard, me, list, detail, pickup, start, arrived, complete, fail, available, claim, earnings, DEFAULTS };