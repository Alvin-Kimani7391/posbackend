/**
 * Live delivery tracking (the Uber-style part).
 *
 *   rider phone  --POST /rider/location-->  ingest()  --> RiderPresence (where is he now)
 *                                                     --> RestaurantOrder.delivery.tracking (distance + ETA to THIS customer)
 *                                                     --> proximity alerts at 500 / 200 / 100 / 50 m (owner can change them)
 *                                                     --> route breadcrumbs (RiderLocationPoint)
 *                                                     --> live events: the customer's page, the manager / cashier board, the rider's phone
 *
 * Who sees what:
 *   customer   his own delivery only (unguessable trackKey), and only while the rider is on the way
 *   staff      every rider and delivery of the branches they may access (permission restaurant.delivery.view)
 *   rider      his own deliveries
 */
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantSettings = require('../../models/RestaurantSettings');
const RiderPresence = require('../../models/RiderPresence');
const RiderLocationPoint = require('../../models/RiderLocationPoint');
const RiderCollection = require('../../models/RiderCollection');
const StoreBooking = require('../../models/StoreBooking');
const User = require('../../models/User');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const geo = require('../../utils/geo');
const S = require('../../utils/storefront');
const { localParts } = require('../../utils/restaurantTime');
const { ROLES } = require('../../constants/roles');
const { DEFAULTS } = require('../../constants/rider');
const hub = require('./realtime.hub');
const push = require('./push.service');
const C = require('../restaurant/common');

const money = (c) => (c === null || c === undefined ? null : Math.round(c) / 100);
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Your rider';
const sid = (v) => (v ? String(v) : '');
const uuid = () => require('crypto').randomBytes(6).toString('hex');
const MGMT = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER];
const CASHIERS = [ROLES.CASHIER, ROLES.SUPERVISOR, ROLES.MANAGER];

// ------------------------------------------------------------------ settings (cached: a ping every few seconds must not hit the database twice)
const cache = new Map();
async function riderSettings(businessId) {
  const key = sid(businessId); const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const doc = await RestaurantSettings.findOne({ businessId }).select('rider storefront.branchLocations').lean();
  const value = { rider: (doc && doc.rider) || {}, branchLocations: (doc && doc.storefront && doc.storefront.branchLocations) || [] };
  cache.set(key, { value, until: Date.now() + 30000 });
  return value;
}
const forgetSettings = (businessId) => cache.delete(sid(businessId));
const thresholds = (rs) => (rs.alertDistancesM && rs.alertDistancesM.length ? [...rs.alertDistancesM] : DEFAULTS.alertDistancesM);
const branchPoint = (cfg, branchId) => { const l = (cfg.branchLocations || []).find((x) => sid(x.branchId) === sid(branchId)); return l && geo.validPoint(l) ? { lat: l.lat, lng: l.lng } : null; };

// ------------------------------------------------------------------ small pure helpers
/** Where the rider is heading: the customer's live spot if they moved it recently (and not absurdly far from the first pin), else the pin they ordered with. */
function targetOf(order) {
  const d = order.delivery || {}; const pin = { lat: d.lat, lng: d.lng }; const live = d.customerLive;
  if (live && geo.validPoint(live) && live.at && Date.now() - new Date(live.at).getTime() < 15 * 60000 && (!geo.validPoint(pin) || geo.distanceM(pin, live) <= 5000)) return { lat: live.lat, lng: live.lng, live: true };
  return geo.validPoint(pin) ? { lat: Number(d.lat), lng: Number(d.lng), live: false } : null;
}
/** The rider-facing stage of a delivery. */
function stageOf(order) {
  const d = order.delivery || {};
  if (order.status === 'CANCELLED') return 'CANCELLED';
  if (d.status === 'DELIVERED') return 'DELIVERED';
  if (d.status === 'FAILED') return 'FAILED';
  if (d.status === 'OUT_FOR_DELIVERY') return d.arrivedAt ? 'ARRIVED' : 'ON_THE_WAY';
  if (d.pickedUpAt) return 'PICKED_UP';
  if (d.status === 'ASSIGNED') return 'ASSIGNED';
  return 'PENDING';
}
const isLive = (order) => (order.delivery || {}).status === 'OUT_FOR_DELIVERY' && order.status === 'OPEN';
const ageSec = (at) => (at ? Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000)) : null);

function proximityText(distanceM, who) {
  const d = geo.fmtDistance(distanceM);
  if (distanceM <= 60) return { title: `${who} is ${d} away`, body: `${who} is very close. Get ready!` };
  if (distanceM <= 250) return { title: `${who} is ${d} away`, body: `${who} is almost at your location.` };
  return { title: `${who} is ${d} away`, body: `${who} is getting close.` };
}

// ------------------------------------------------------------------ fan-out
/** One place that tells everybody who cares: the customer's page + phone, the staff board. */
function emit(order, event, data = {}) {
  const d = order.delivery || {};
  const payload = { orderId: order._id, orderNumber: order.orderNumber, branchId: order.branchId, stage: stageOf(order), ...data };
  if (d.trackKey) { const { orderId, branchId, branchIds, riderId, ...forCustomer } = payload; hub.publish(hub.ch.track(d.trackKey), event, forCustomer); }   // the customer never receives ids or branch data
  hub.publish(hub.ch.biz(order.businessId), event, payload);
}
async function addAlert(order, kind, message, { distanceM, title, push: pushIt = true } = {}) {
  const a = { id: uuid(), kind, distanceM, message, at: new Date() };
  await RestaurantOrder.updateOne({ _id: order._id }, { $push: { 'delivery.alerts': { $each: [a], $slice: -20 } } });
  const d = order.delivery || {};
  if (d.trackKey) hub.publish(hub.ch.track(d.trackKey), 'alert', { ...a, title: title || message });
  if (pushIt && d.trackKey) push.toCustomer(order.businessId, d.trackKey, { title: title || 'Six Star delivery', body: message, tag: `delivery-${d.trackKey}`, url: `?key=${d.trackKey}`, data: { kind, trackKey: d.trackKey } }).catch(() => {});
  return a;
}
/** Cashiers / supervisors (roles) and, unless `management: false`, every owner / admin / manager. Routine events skip management: they watch the live board instead. */
async function notifyStaff(order, roles, payload, { management = true } = {}) {
  const base = { branchId: order.branchId, entityType: 'RestaurantOrder', entityId: order._id, ...payload };
  if (roles.length) await C.notifyRoles(order.businessId, order.branchId, roles.filter((r) => !MGMT.includes(r)), base);
  if (management) await C.notifyManagement(order.businessId, base);
}

// ------------------------------------------------------------------ rider on / off duty
async function setOnline(businessId, user, online, { lat, lng, battery, device } = {}) {
  const now = new Date(); const set = { riderName: user.name, branchIds: user.branchIds || [], online: !!online, lastSeenAt: now };
  if (device) set.device = String(device).slice(0, 120);
  if (battery) set.battery = battery;
  if (geo.validPoint({ lat, lng })) set.location = { lat: Number(lat), lng: Number(lng), at: now };
  const prev = await RiderPresence.findOneAndUpdate({ businessId, riderId: user._id }, { $set: set }, { upsert: true, new: false });
  if (online && (!prev || !prev.online)) await RiderPresence.updateOne({ businessId, riderId: user._id }, { $set: { onlineSince: now }, $unset: { quietNotifiedAt: 1 } });
  hub.publish(hub.ch.biz(businessId), 'rider', { type: online ? 'rider_online' : 'rider_offline', riderId: user._id, name: user.name, branchIds: user.branchIds || [], online: !!online, at: now });
  return presenceView(await RiderPresence.findOne({ businessId, riderId: user._id }).lean());
}
const presenceView = (p) => p && ({
  riderId: p.riderId, name: p.riderName, online: !!p.online && ageSec(p.lastSeenAt) <= DEFAULTS.offlineAfterSec, quiet: !!p.online && ageSec(p.lastSeenAt) > DEFAULTS.offlineAfterSec, onlineSince: p.onlineSince, lastSeenAt: p.lastSeenAt, lastSeenSec: ageSec(p.lastSeenAt),
  location: p.location && p.location.lat ? { lat: p.location.lat, lng: p.location.lng, heading: p.location.heading, speed: p.location.speed, accuracy: p.location.accuracy, at: p.location.at, ageSec: ageSec(p.location.at) } : null,
  battery: p.battery || null,
});

// ------------------------------------------------------------------ the location ping
/**
 * body: { lat, lng, accuracy?, heading?, speed? (m/s), battery?: {level 0-1, charging}, recordedAt? }
 * Cheap on purpose (one presence write + one write per active delivery): the phone calls this every few seconds.
 */
async function ingest(businessId, user, body) {
  const pt = { lat: Number(body.lat), lng: Number(body.lng) };
  if (!geo.validPoint(pt)) throw ApiError.badRequest('That location is not valid', 'INVALID_LOCATION');
  const now = new Date();
  const accuracy = Number.isFinite(+body.accuracy) ? +body.accuracy : undefined;
  const speed = Number.isFinite(+body.speed) && +body.speed >= 0 ? +body.speed : undefined;
  const heading = Number.isFinite(+body.heading) && +body.heading >= 0 ? +body.heading : undefined;
  const { rider: rs } = await riderSettings(businessId);
  const location = { lat: pt.lat, lng: pt.lng, accuracy, heading, speed, at: now };

  const prev = await RiderPresence.findOneAndUpdate({ businessId, riderId: user._id },
    { $set: { riderName: user.name, branchIds: user.branchIds || [], online: true, lastSeenAt: now, location, ...(body.battery ? { battery: { level: body.battery.level, charging: !!body.battery.charging } } : {}) }, $unset: { quietNotifiedAt: 1 } },
    { upsert: true, new: false });
  if (!prev || !prev.online) await RiderPresence.updateOne({ businessId, riderId: user._id }, { $set: { onlineSince: now } });
  if (body.battery && body.battery.level <= 0.15 && !body.battery.charging && (!prev || !prev.battery || prev.battery.level > 0.15)) lowBattery(businessId, user, body.battery.level).catch(() => {});

  const orders = await RestaurantOrder.find({ businessId, orderType: 'DELIVERY', status: 'OPEN', 'delivery.riderId': user._id, 'delivery.status': 'OUT_FOR_DELIVERY' })
    .select('orderNumber branchId businessId status delivery customerName').lean();

  const trailLast = prev && prev.trailLast;
  const keepPoint = orders.length && (!trailLast || !trailLast.lat || geo.distanceM(pt, trailLast) >= DEFAULTS.trailMinMoveM || (now - new Date(trailLast.at)) / 1000 >= DEFAULTS.trailMinSeconds);
  if (keepPoint) {
    RiderLocationPoint.insertMany(orders.map((o) => ({ businessId, orderId: o._id, riderId: user._id, lat: pt.lat, lng: pt.lng, accuracy, speed, heading, at: now })), { ordered: false }).catch(() => {});
    RiderPresence.updateOne({ businessId, riderId: user._id }, { $set: { trailLast: { lat: pt.lat, lng: pt.lng, at: now } } }).catch(() => {});
  }

  const results = [];
  const precise = accuracy === undefined || accuracy <= DEFAULTS.minAccuracyForAlertsM;
  for (const o of orders) {
    const tgt = targetOf(o); const t = o.delivery.tracking || {};
    let distanceM = null; let eta = null;
    if (tgt) { distanceM = geo.distanceM(pt, tgt); eta = geo.etaMinutes(distanceM, { speedMps: speed, fallbackKmh: DEFAULTS.fallbackSpeedKmh }); }
    const set = { 'delivery.tracking.lat': pt.lat, 'delivery.tracking.lng': pt.lng, 'delivery.tracking.at': now };
    if (speed !== undefined) set['delivery.tracking.speed'] = speed;
    if (heading !== undefined) set['delivery.tracking.heading'] = heading;
    if (distanceM !== null) { set['delivery.tracking.distanceM'] = distanceM; set['delivery.tracking.etaMinutes'] = eta; }
    await RestaurantOrder.updateOne({ _id: o._id }, { $set: set, ...(distanceM !== null ? { $min: { 'delivery.tracking.minDistanceM': distanceM } } : {}) });

    emit(o, 'location', { riderId: user._id, riderName: user.name, lat: pt.lat, lng: pt.lng, heading, speed, at: now, distanceM, etaMinutes: eta, branchIds: user.branchIds || [o.branchId] });

    let announced = null;
    if (tgt && precise && !o.delivery.arrivedAt) announced = await proximity(o, t, distanceM, thresholds(rs));
    let nearDestination = false;
    if (tgt && precise && distanceM <= DEFAULTS.arrivalRadiusM && !o.delivery.arrivedAt && !t.nearNotified) {
      const got = await RestaurantOrder.updateOne({ _id: o._id, 'delivery.tracking.nearNotified': { $ne: true } }, { $set: { 'delivery.tracking.nearNotified': true } });
      if (got.modifiedCount === 1) {
        nearDestination = true;
        hub.publish(hub.ch.user(user._id), 'near_destination', { orderId: o._id, orderNumber: o.orderNumber, distanceM });
        if (rs.autoArrive) markArrived(businessId, null, o._id, { auto: true, lat: pt.lat, lng: pt.lng }).catch((e) => logger.warn('auto arrive failed', { error: e.message }));
      }
    }
    results.push({ orderId: o._id, orderNumber: o.orderNumber, distanceM, etaMinutes: eta, announced, nearDestination });
  }
  hub.publish(hub.ch.biz(businessId), 'rider', { type: 'rider_location', riderId: user._id, name: user.name, lat: pt.lat, lng: pt.lng, heading, speed, accuracy, at: now, online: true, orderIds: orders.map((o) => o._id), branchIds: user.branchIds || [], battery: body.battery });
  return { ok: true, at: now, deliveries: results };
}

/** Tells the customer at most ONE new thing per ping, and never the same distance twice (even if two pings race). */
async function proximity(order, t, distanceM, list) {
  const { crossed, notify } = geo.crossedAlerts(distanceM, list, t.alertsSent);
  if (!crossed.length) return null;
  const won = await RestaurantOrder.updateOne({ _id: order._id, 'delivery.tracking.alertsSent': { $nin: crossed } }, { $addToSet: { 'delivery.tracking.alertsSent': { $each: crossed } } });
  if (won.modifiedCount !== 1) return null;
  const who = firstName(order.delivery.riderName); const tx = proximityText(distanceM, who);
  await addAlert(order, 'PROXIMITY', tx.body, { distanceM: notify, title: tx.title });
  return notify;
}

// ------------------------------------------------------------------ rider presses "Arrived at location"
async function markArrived(businessId, user, orderId, { auto = false, lat, lng } = {}) {
  const order = await C.loadOrder(businessId, orderId);
  const d = order.delivery || {};
  if (order.orderType !== 'DELIVERY') throw ApiError.badRequest('Not a delivery order', 'NOT_DELIVERY');
  if (user && !C.sameId(d.riderId, user._id) && !C.can(user, 'restaurant.delivery.manage')) throw ApiError.forbidden('This delivery is not yours', 'PERMISSION_DENIED');
  if (d.status !== 'OUT_FOR_DELIVERY') throw ApiError.conflict(`Delivery is ${d.status || 'not started'}. Start the delivery first.`, 'INVALID_DELIVERY_STATE');
  if (d.arrivedAt) return order;
  const pos = geo.validPoint({ lat, lng }) ? { lat: Number(lat), lng: Number(lng) } : (d.tracking && geo.validPoint(d.tracking) ? { lat: d.tracking.lat, lng: d.tracking.lng } : null);
  const tgt = targetOf(order); const far = pos && tgt ? geo.distanceM(pos, tgt) : null;
  const farFlag = !auto && far !== null && far > 250 ? far : undefined;
  const got = await RestaurantOrder.updateOne({ _id: order._id, 'delivery.arrivedAt': { $exists: false } }, { $set: { 'delivery.arrivedAt': new Date(), ...(farFlag ? { 'delivery.arrivedFarM': farFlag } : {}) } });
  if (got.modifiedCount !== 1) return C.loadOrder(businessId, orderId);
  const fresh = await C.loadOrder(businessId, orderId);
  await addAlert(fresh, 'ARRIVED', `${firstName(d.riderName)} has arrived at your location.`, { distanceM: 0, title: 'Your rider has arrived' });
  emit(fresh, 'status', { event: 'ARRIVED', riderId: d.riderId, branchIds: [order.branchId] });
  if (farFlag) notifyStaff(fresh, [], { type: 'DELIVERY_ARRIVED', title: `Check delivery ${order.orderNumber}`, message: `${d.riderName} pressed "Arrived" about ${geo.fmtDistance(farFlag)} from the customer's pin.`, severity: 'warning' }).catch(() => {});
  C.audit({ businessId, branchId: order.branchId, userId: user ? user._id : d.riderId, action: 'restaurant.delivery.arrived', entityType: 'RestaurantOrder', entityId: order._id, newValue: { auto, farM: far } }).catch(() => {});
  return fresh;
}

// ------------------------------------------------------------------ hooks called by order.service when a delivery changes state
async function onAssigned(order, rider) {
  try {
    emit(order, 'status', { event: 'ASSIGNED', riderId: rider._id, riderName: rider.name, branchIds: [order.branchId] });
    hub.publish(hub.ch.user(rider._id), 'assigned', { orderId: order._id, orderNumber: order.orderNumber, address: order.delivery.address });
    push.toUsers(order.businessId, [rider._id], { title: `New delivery ${order.orderNumber}`, body: order.delivery.address || 'Open the app for details', tag: `assign-${order._id}`, url: `#delivery=${order._id}`, data: { orderId: String(order._id) } }).catch(() => {});
    if (order.delivery.trackKey) await addAlert(order, 'ASSIGNED', `${firstName(rider.name)} will deliver your order.`, { title: 'A rider is assigned', push: false });
  } catch (e) { logger.warn('onAssigned failed', { error: e.message }); }
}

async function onStatus(order, status, user, reason) {
  try {
    const d = order.delivery || {}; const who = firstName(d.riderName);
    if (status === 'OUT_FOR_DELIVERY') {
      await RestaurantOrder.updateOne({ _id: order._id }, { $set: { 'delivery.tracking.alertsSent': [], 'delivery.tracking.nearNotified': false }, $unset: { 'delivery.arrivedAt': 1, 'delivery.arrivedFarM': 1 } });
      if (!d.pickedUpAt) await RestaurantOrder.updateOne({ _id: order._id, 'delivery.pickedUpAt': { $exists: false } }, { $set: { 'delivery.pickedUpAt': new Date() } });
      await addAlert(order, 'ON_THE_WAY', `${who} has picked up your order and is on the way.`, { title: 'Your order is on the way' });
      emit(order, 'status', { event: 'ON_THE_WAY', riderId: d.riderId, riderName: d.riderName, branchIds: [order.branchId] });
      await notifyStaff(order, CASHIERS, { type: 'DELIVERY_STARTED', title: `Out for delivery ${order.orderNumber}`, message: `${d.riderName} left with ${order.orderNumber} for ${d.address || 'the customer'}.` }, { management: false });
    } else if (status === 'DELIVERED') {
      await addAlert(order, 'DELIVERED', 'Your order has been delivered. Enjoy your meal!', { title: 'Order delivered' });
      emit(order, 'status', { event: 'DELIVERED', riderId: d.riderId, branchIds: [order.branchId] });
      await notifyStaff(order, CASHIERS, { type: 'DELIVERY_COMPLETED', title: `Delivered ${order.orderNumber}`, message: `${d.riderName} delivered ${order.orderNumber}.` }, { management: false });
    } else if (status === 'FAILED') {
      await addAlert(order, 'FAILED', 'We could not deliver your order. Please call us.', { title: 'Delivery problem' });
      emit(order, 'status', { event: 'FAILED', riderId: d.riderId, branchIds: [order.branchId] });
      await notifyStaff(order, CASHIERS, { type: 'DELIVERY_FAILED', title: `Delivery failed ${order.orderNumber}`, message: `${d.riderName || (user && user.name)} could not deliver ${order.orderNumber}${reason ? `: ${reason}` : ''}.` });
    }
  } catch (e) { logger.warn('onStatus failed', { error: e.message, status }); }
}

// ------------------------------------------------------------------ CUSTOMER view
const STEPS = [['CONFIRMED', 'Confirmed'], ['PICKED_UP', 'Picked Up'], ['ON_THE_WAY', 'On the Way'], ['DELIVERED', 'Delivered']];
function timeline(order, stage) {
  const d = order.delivery || {}; const live = (order.items || []).some((i) => i.status !== 'DRAFT' && i.status !== 'CANCELLED');
  const done = { CONFIRMED: live, PICKED_UP: !!(d.pickedUpAt || ['ON_THE_WAY', 'ARRIVED', 'DELIVERED'].includes(stage)), ON_THE_WAY: ['ON_THE_WAY', 'ARRIVED', 'DELIVERED'].includes(stage), DELIVERED: stage === 'DELIVERED' };
  const current = STEPS.map(([k]) => k).filter((k) => done[k]).pop() || 'CONFIRMED';
  return STEPS.map(([key, label]) => ({ key, label, done: done[key], current: key === current }));
}
async function trailOf(orderId, max = 100) {
  const pts = await RiderLocationPoint.find({ orderId }).sort({ at: 1 }).limit(600).select('lat lng -_id').lean();
  return geo.decimate(pts.map((p) => [p.lat, p.lng]), max);
}

/**
 * What the customer's tracking screen draws. `since` (ISO time) returns only alerts newer than that, so polling never repeats a notification.
 * The rider's position is shown only while he is on the way; before that and after delivery the map has nothing live to leak.
 */
async function customerLive(businessId, trackKey, { since } = {}) {
  const order = await RestaurantOrder.findOne({ businessId, 'delivery.trackKey': String(trackKey) }).select('-history').lean();
  if (!order) throw ApiError.notFound('We could not find that order.', 'ORDER_NOT_FOUND');
  const d = order.delivery || {}; const stage = stageOf(order); const live = isLive(order);
  const cfg = await riderSettings(businessId); const tgt = targetOf(order); const t = d.tracking || {};
  const sb = await StoreBooking.findOne({ businessId, kind: 'ORDER', refId: order._id }).select('payState amountDue').lean();
  const alerts = (d.alerts || []).filter((a) => !since || new Date(a.at) > new Date(since)).map((a) => ({ id: a.id, kind: a.kind, distanceM: a.distanceM, message: a.message, at: a.at }));
  const coll = await RiderCollection.findOne({ businessId, orderId: order._id, status: { $in: ['HELD', 'PAID', 'HANDED_OVER', 'AWAITING_MPESA'] } }).select('method status amount').lean();
  const locAge = ageSec(t.at);
  return {
    trackKey: d.trackKey, orderNumber: order.orderNumber, stage, arrived: !!d.arrivedAt, live,
    message: ({ PENDING: 'We have your order.', ASSIGNED: 'A rider has been assigned.', PICKED_UP: 'Your rider has your order.', ON_THE_WAY: t.etaMinutes != null ? `Arriving in ${t.etaMinutes <= 0 ? 'less than a minute' : `${t.etaMinutes} min`}.` : 'Your rider is on the way.', ARRIVED: 'Your rider has arrived at your location.', DELIVERED: 'Delivered. Enjoy your meal!', FAILED: 'We could not deliver this order. Please call us.', CANCELLED: 'This order was cancelled.' })[stage],
    etaMinutes: live ? (t.etaMinutes != null ? t.etaMinutes : d.etaMinutes) : null,
    distanceM: live && t.distanceM != null ? t.distanceM : null,
    rider: d.riderName ? { name: firstName(d.riderName), fullName: d.riderName, phone: live && cfg.rider.shareRiderPhone !== false ? d.riderPhone || null : null } : null,
    riderLocation: live && t.lat ? { lat: t.lat, lng: t.lng, heading: t.heading, speedKmh: t.speed != null ? Math.round(t.speed * 3.6) : null, at: t.at, ageSec: locAge, stale: locAge > DEFAULTS.staleAfterSec } : null,
    destination: tgt ? { lat: tgt.lat, lng: tgt.lng, address: d.address, sharedLive: tgt.live } : null,
    origin: branchPoint(cfg, order.branchId),
    trail: live ? await trailOf(order._id) : [],
    steps: timeline(order, stage), alerts,
    pay: { method: d.payment || 'CASH', state: sb ? sb.payState : 'COD', rider: coll ? { method: coll.method, status: coll.status, amount: money(coll.amount) } : null },
    deliveredAt: d.deliveredAt || null, rating: d.rating && d.rating.stars ? d.rating.stars : null, canRate: stage === 'DELIVERED' && !(d.rating && d.rating.stars),
    serverTime: new Date(),
  };
}

/** The customer moved (or shares where they stand): the rider is now guided to this spot. */
async function customerMove(businessId, trackKey, { lat, lng }) {
  const pt = { lat: Number(lat), lng: Number(lng) };
  if (!geo.validPoint(pt)) throw ApiError.badRequest('That location is not valid', 'INVALID_LOCATION');
  const order = await RestaurantOrder.findOne({ businessId, 'delivery.trackKey': String(trackKey), status: 'OPEN' }).select('delivery orderNumber branchId businessId');
  if (!order || ['DELIVERED', 'FAILED'].includes(order.delivery.status)) throw ApiError.conflict('This order is no longer being delivered.', 'NOT_ACTIVE');
  const pin = { lat: order.delivery.lat, lng: order.delivery.lng };
  if (geo.validPoint(pin) && geo.distanceM(pin, pt) > 5000) throw ApiError.badRequest('That is too far from the address you ordered to. Please call the restaurant to change it.', 'TOO_FAR_FROM_PIN');
  await RestaurantOrder.updateOne({ _id: order._id }, { $set: { 'delivery.customerLive': { lat: pt.lat, lng: pt.lng, at: new Date() }, 'delivery.tracking.alertsSent': [], 'delivery.tracking.nearNotified': false } });
  if (order.delivery.riderId) hub.publish(hub.ch.user(order.delivery.riderId), 'customer_moved', { orderId: order._id, orderNumber: order.orderNumber, lat: pt.lat, lng: pt.lng });
  emit(order, 'customer', { lat: pt.lat, lng: pt.lng, branchIds: [order.branchId] });
  return { ok: true };
}

async function rate(businessId, trackKey, { stars, comment }) {
  const order = await RestaurantOrder.findOne({ businessId, 'delivery.trackKey': String(trackKey) }).select('delivery orderNumber branchId businessId');
  if (!order) throw ApiError.notFound('We could not find that order.', 'ORDER_NOT_FOUND');
  if (order.delivery.status !== 'DELIVERED') throw ApiError.conflict('You can rate the rider once your order is delivered.', 'NOT_DELIVERED');
  const got = await RestaurantOrder.updateOne({ _id: order._id, 'delivery.rating.stars': { $exists: false } }, { $set: { 'delivery.rating': { stars, comment: comment || undefined, at: new Date() } } });
  if (got.modifiedCount !== 1) throw ApiError.conflict('You already rated this delivery. Thank you!', 'ALREADY_RATED');
  if (stars <= 2) notifyStaff(order, [], { type: 'DELIVERY_RATED', title: `Low rating for ${order.orderNumber}`, message: `${order.delivery.riderName || 'The rider'} got ${stars} star(s)${comment ? `: ${comment}` : ''}`, severity: 'warning' }).catch(() => {});
  return { ok: true };
}

// ------------------------------------------------------------------ STAFF views
const startOfToday = (tz) => S.zonedDate(localParts(new Date(), tz).date, '00:00', tz);
const customerOf = (o) => ({ name: (o.delivery && o.delivery.contactName) || o.customerName, phone: (o.delivery && o.delivery.phone) || o.customerPhone, address: o.delivery && o.delivery.address, landmark: o.delivery && o.delivery.landmark, lat: o.delivery && o.delivery.lat, lng: o.delivery && o.delivery.lng, sharedLive: !!(o.delivery && o.delivery.customerLive && o.delivery.customerLive.lat) });

function deliveryRow(o, cfg, coll) {
  const d = o.delivery || {}; const t = d.tracking || {}; const tgt = targetOf(o);
  return {
    orderId: o._id, orderNumber: o.orderNumber, branchId: o.branchId, stage: stageOf(o), status: d.status || 'PENDING', placedAt: o.createdAt,
    customer: customerOf(o), destination: tgt, origin: branchPoint(cfg, o.branchId),
    rider: d.riderId ? { id: d.riderId, name: d.riderName, phone: d.riderPhone || null } : null,
    location: isLive(o) && t.lat ? { lat: t.lat, lng: t.lng, heading: t.heading, at: t.at, ageSec: ageSec(t.at) } : null,
    distanceM: isLive(o) ? t.distanceM ?? null : null, etaMinutes: isLive(o) ? t.etaMinutes ?? d.etaMinutes ?? null : d.etaMinutes ?? null,
    total: money(o.totals && o.totals.total), payment: { method: d.payment || 'CASH', rider: coll ? { method: coll.method, status: coll.status, amount: money(coll.amount) } : null },
    arrivedAt: d.arrivedAt || null, arrivedFarM: d.arrivedFarM || null, deliveredAt: d.deliveredAt || null, rating: d.rating && d.rating.stars ? d.rating.stars : null,
  };
}

/** The manager / owner / cashier live board: every rider on the map, every active delivery, and the three headline numbers. */
async function liveBoard(businessId, user, { branchId } = {}) {
  const scope = C.branchScope(user, branchId); const bf = C.branchFilter(scope);
  const ctx = await C.getContext(businessId); const cfg = await riderSettings(businessId);
  const since = startOfToday(ctx.timeZone);
  const [orders, doneToday, presences, riders] = await Promise.all([
    RestaurantOrder.find({ businessId, ...bf, orderType: 'DELIVERY', status: 'OPEN', 'delivery.status': { $nin: ['DELIVERED', 'FAILED'] }, createdAt: { $gt: new Date(Date.now() - 36 * 3600000) } })
      .select('orderNumber branchId status items.status customerName customerPhone delivery totals createdAt').sort({ createdAt: 1 }).limit(300).lean(),
    RestaurantOrder.countDocuments({ businessId, ...bf, orderType: 'DELIVERY', 'delivery.status': 'DELIVERED', 'delivery.deliveredAt': { $gte: since } }),
    RiderPresence.find({ businessId, ...(scope === null ? {} : { $or: [{ branchIds: { $in: scope } }, { branchIds: { $size: 0 } }] }) }).lean(),
    User.find({ businessId, role: ROLES.DELIVERY_RIDER, status: 'active', ...(scope === null ? {} : { $or: [{ branchIds: { $in: scope } }, { branchIds: { $size: 0 } }] }) }).select('name phone branchIds').lean(),
  ]);
  const colls = orders.length ? await RiderCollection.find({ businessId, orderId: { $in: orders.map((o) => o._id) }, status: { $in: ['HELD', 'PAID', 'HANDED_OVER', 'AWAITING_MPESA'] } }).select('orderId method status amount').lean() : [];
  const cm = new Map(colls.map((c) => [sid(c.orderId), c]));
  const deliveries = orders.map((o) => deliveryRow(o, cfg, cm.get(sid(o._id))));
  const pm = new Map(presences.map((p) => [sid(p.riderId), p]));
  const held = await RiderCollection.aggregate([{ $match: { businessId: C.oid(businessId), status: 'HELD' } }, { $group: { _id: '$riderId', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]);
  const hm = new Map(held.map((h) => [sid(h._id), h]));
  const riderList = riders.map((r) => {
    const p = presenceView(pm.get(sid(r._id))) || { riderId: r._id, name: r.name, online: false, location: null, lastSeenAt: null };
    const mine = deliveries.filter((x) => x.rider && sid(x.rider.id) === sid(r._id));
    return { ...p, riderId: r._id, name: r.name, phone: r.phone, activeDeliveries: mine.map((x) => ({ orderId: x.orderId, orderNumber: x.orderNumber, stage: x.stage })), cashHeld: money((hm.get(sid(r._id)) || {}).amount || 0), cashHeldCount: (hm.get(sid(r._id)) || {}).count || 0 };
  }).sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(b.name));
  return {
    stats: { activeRiders: riderList.filter((r) => r.online).length, onDelivery: deliveries.filter((x) => ['ON_THE_WAY', 'ARRIVED', 'PICKED_UP'].includes(x.stage)).length, completedToday: doneToday, unassigned: deliveries.filter((x) => !x.rider).length },
    riders: riderList, deliveries, serverTime: new Date(),
  };
}

/** One delivery in full for the staff map: customer, rider, route line, payment, alerts sent. */
async function orderTrack(businessId, user, orderId) {
  const o = await C.loadOrder(businessId, orderId); C.assertBranchAccess(user, o.branchId);
  if (o.orderType !== 'DELIVERY') throw ApiError.badRequest('Not a delivery order', 'NOT_DELIVERY');
  const plain = o.toObject({ transform: false, virtuals: false }); const cfg = await riderSettings(businessId);
  const coll = await RiderCollection.findOne({ businessId, orderId: o._id, status: { $ne: 'CANCELLED' } }).lean();
  const p = plain.delivery.riderId ? await RiderPresence.findOne({ businessId, riderId: plain.delivery.riderId }).lean() : null;
  return { ...deliveryRow(plain, cfg, coll), items: (plain.items || []).filter((i) => i.status !== 'CANCELLED' && !i.parentItemId).map((i) => ({ name: i.name, quantity: i.quantity })), trail: await trailOf(o._id, 300), alerts: (plain.delivery.alerts || []).map((a) => ({ kind: a.kind, distanceM: a.distanceM, message: a.message, at: a.at })), riderPresence: presenceView(p), pickedUpAt: plain.delivery.pickedUpAt || null, assignedAt: plain.delivery.assignedAt || null, outForDeliveryAt: plain.delivery.outForDeliveryAt || null };
}

// ------------------------------------------------------------------ housekeeping (called by jobs/rider.job.js every minute)
async function lowBattery(businessId, user, level) {
  const o = await RestaurantOrder.findOne({ businessId, 'delivery.riderId': user._id, 'delivery.status': 'OUT_FOR_DELIVERY', status: 'OPEN' }).select('branchId');
  if (!o) return;
  await C.notifyManagement(businessId, { type: 'RIDER_LOW_BATTERY', title: `${user.name}'s phone battery is low`, message: `${Math.round(level * 100)}% left while on a delivery. Tracking may stop.`, branchId: o.branchId, entityType: 'User', entityId: user._id });
}
async function sweep() {
  const now = Date.now(); const cutoff = new Date(now - DEFAULTS.offlineAfterSec * 1000);
  const stale = await RiderPresence.find({ online: true, lastSeenAt: { $lt: cutoff } }).limit(200).lean();
  for (const p of stale) {
    const busy = await RestaurantOrder.findOne({ businessId: p.businessId, 'delivery.riderId': p.riderId, 'delivery.status': 'OUT_FOR_DELIVERY', status: 'OPEN' }).select('orderNumber branchId delivery.riderName').lean();
    if (busy) {                                   // gone quiet in the middle of a delivery: tell management once, keep the rider "on duty"
      if (!p.quietNotifiedAt) {
        const got = await RiderPresence.updateOne({ _id: p._id, quietNotifiedAt: { $exists: false } }, { $set: { quietNotifiedAt: new Date() } });
        if (got.modifiedCount === 1) C.notifyManagement(p.businessId, { type: 'RIDER_WENT_QUIET', title: `${p.riderName || 'A rider'} stopped sharing location`, message: `No location for ${Math.round((now - new Date(p.lastSeenAt)) / 60000)} min while delivering ${busy.orderNumber}. Call the rider.`, branchId: busy.branchId, entityType: 'RestaurantOrder', entityId: busy._id });
        hub.publish(hub.ch.biz(p.businessId), 'rider', { type: 'rider_quiet', riderId: p.riderId, name: p.riderName, branchIds: p.branchIds || [], at: new Date() });
      }
    } else if (new Date(p.lastSeenAt) < new Date(now - 10 * 60000)) {
      await RiderPresence.updateOne({ _id: p._id }, { $set: { online: false } });
      hub.publish(hub.ch.biz(p.businessId), 'rider', { type: 'rider_offline', riderId: p.riderId, name: p.riderName, branchIds: p.branchIds || [], online: false, at: new Date() });
    }
  }
}

module.exports = { ingest, setOnline, markArrived, onAssigned, onStatus, customerLive, customerMove, rate, liveBoard, orderTrack, sweep, stageOf, targetOf, presenceView, forgetSettings, riderSettings, addAlert, emit, notifyStaff, customerOf, timeline, firstName, money, CASHIERS };