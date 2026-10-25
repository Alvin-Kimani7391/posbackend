/**
 * The business storefront behind the ONE business QR code: browse the menu and offers, order delivery (with a map pin), see which
 * tables are free and reserve one (optionally pre-ordering food), see rooms and book one with the owner's deposit, follow it all.
 * Everything lands in the screens staff already use: delivery orders in Delivery, bookings in Reservations, stays in Front desk.
 * No login: the signed token in the URL identifies the business; guests follow their own order with an unguessable key, or with a
 * booking code + the last 4 digits of their phone.
 */
const ApiError = require('../../utils/ApiError');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantTable = require('../../models/RestaurantTable');
const RestaurantArea = require('../../models/RestaurantArea');
const Reservation = require('../../models/Reservation');
const MenuItem = require('../../models/MenuItem');
const Branch = require('../../models/Branch');
const RoomType = require('../../models/RoomType');
const Stay = require('../../models/Stay');
const MpesaTransaction = require('../../models/MpesaTransaction');
const StoreBooking = require('../../models/StoreBooking');
const RestaurantBill = require('../../models/RestaurantBill');
const GuestReceipt = require('../../models/GuestReceipt');
const acct = require('../hospitality/guest-account.service');
const IntegrationSettings = require('../../models/IntegrationSettings');
const { RESERVATION_ACTIVE } = require('../../constants/restaurant');
const S = require('../../utils/storefront');
const R = require('../../utils/hospitalityRates');
const T = require('../../utils/hospitalityTime');
const { localParts } = require('../../utils/restaurantTime');
const qr = require('../hospitality/qr.service');
const G = require('../hospitality/guest.service');
const C = require('../hospitality/common');
const orders = require('../restaurant/order.service');
const bills = require('../restaurant/bill.service');
const reservations = require('../restaurant/reservation.service');
const stays = require('../hospitality/stay.service');
const folio = require('../hospitality/folio.service');
const mpesa = require('../mpesa.service');
const RC = require('../restaurant/common');
const B = require('../../utils/restaurantBilling');

const HOLD_MIN = 15;            // how long an unpaid order / table is held while the customer pays
const STAY_HOLD_MIN = 30;       // same for a room deposit
const REQUIRE_ACCOUNT = process.env.STORE_GUEST_CHECKOUT !== 'true';   // set STORE_GUEST_CHECKOUT=true to let people order without an account
const money = (c) => (c === null || c === undefined ? null : Math.round(c) / 100);
const STAFF = ['MANAGER', 'CASHIER', 'SUPERVISOR', 'HEAD_WAITER', 'WAITER'];
const FRONT = ['MANAGER', 'RECEPTIONIST', 'CASHIER'];

async function open(token) {
  const r = await qr.resolve(token, { store: true });
  if (r.kind !== 'STORE') throw ApiError.notFound('This QR code is not valid any more.', 'QR_INVALID');
  return { ...r, businessId: r.doc.businessId };
}
const branchesOf = (businessId) => Branch.find({ businessId, status: 'active' }).sort({ isMainBranch: -1, name: 1 });
async function pickBranch(r, branchId) {
  const list = await branchesOf(r.businessId); if (!list.length) throw ApiError.badRequest('This business has no branch set up', 'NO_BRANCH');
  const b = branchId ? list.find((x) => String(x._id) === String(branchId)) : list[0];
  if (!b) throw ApiError.badRequest('Choose one of our branches', 'BRANCH_NOT_FOUND'); return b;
}
const pointOf = (st, branchId) => { const l = (st.branchLocations || []).find((x) => String(x.branchId) === String(branchId)); return l && S.validPoint(l) ? { lat: l.lat, lng: l.lng } : null; };
const notify = (r, branch, roles, title, message, entityType, entityId) => {
  const payload = { type: 'GUEST_ORDER_PLACED', title, message, branchId: branch._id || branch, entityType, entityId };
  C.notifyRoles(r.businessId, branch._id || branch, roles, payload);
  try { require('../notification.service').notifyManagement(r.businessId, { ...payload, branchId: branch._id || branch }).catch(() => {}); } catch (e) { /* best effort */ }
};

/**
 * What the customer really owes for an online order. Items that are waiting for payment are DRAFT until the money is in, and the order's stored
 * totals (and the POS) ignore drafts - which used to make every pay-first order show "nothing is due" / pay 0 (only the delivery fee was counted).
 * Everything not cancelled counts here, so the amount asked from the customer is the same as the bill the till will produce.
 */
function liveTotalsSync(o, rc) {
  const lines = (o.items || []).filter((i) => i.status !== 'CANCELLED' && !i.parentItemId).map((i) => B.buildLine(i, rc.taxInclusive));
  return B.billTotals(lines, RC.scConfig(rc.settings, o.orderType));
}
async function liveTotals(o, rc) { return liveTotalsSync(o, rc || await RC.getContext(o.businessId)); }

// ------------------------------------------------------------------ context + menu
async function mpesaOn(businessId) {
  const m = await IntegrationSettings.findOne({ businessId }).select('mpesa.enabled mpesa.channelId');
  return !!(m && m.mpesa && m.mpesa.enabled && m.mpesa.channelId);
}
/** The signed-in customer (or null). Same account the table/room QR page uses. */
async function accountFrom(token, req) { const r = await open(token); return acct.fromRequest(req, r.businessId); }
function needAccount(account) { if (REQUIRE_ACCOUNT && !account) throw ApiError.unauthorized('Please sign in or create an account to continue.', 'GUEST_AUTH_REQUIRED'); }

async function context(token) {
  const r = await open(token); const { ctx, store: st } = r;
  const branches = await branchesOf(r.businessId); const d = st.delivery || {}; const t = st.tables || {};
  const now = new Date(); const accOn = ctx.features.accommodation && st.rooms?.enabled !== false;
  const dep = ctx.acc?.deposit || {}; const mp = await mpesaOn(r.businessId);
  const cashOk = (d.payment || 'MPESA_OR_CASH') !== 'MPESA' || !mp;
  return {
    business: { name: ctx.business.name, logo: ctx.business.logo, phone: ctx.business.phone, currency: ctx.business.currency || 'KES', timezone: ctx.timeZone, address: ctx.business.address },
    store: { tagline: st.tagline, welcomeMessage: st.welcomeMessage, themeColor: st.themeColor || '#0f766e' },
    branches: branches.map((b) => ({ id: b._id, name: b.name, phone: b.phone, address: b.address, hasPin: !!pointOf(st, b._id), location: pointOf(st, b._id) })),
    delivery: { enabled: d.enabled !== false, paused: !!d.paused, openNow: S.withinHours(now, ctx.timeZone, d.hoursStart, d.hoursEnd), hours: d.hoursStart && d.hoursEnd ? `${d.hoursStart} - ${d.hoursEnd}` : null, baseFee: money(d.baseFeeCents), perKm: money(d.perKmCents), minOrder: money(d.minOrderCents), maxRadiusKm: d.maxRadiusKm || null, allowCash: cashOk },
    tables: { enabled: ctx.features.tables !== false && t.enabled !== false, openTime: t.openTime || '10:00', closeTime: t.closeTime || '22:00', depositRequired: !!ctx.settings.reservation?.depositRequired, deposit: money(ctx.settings.reservation?.depositCents || 0), requirePayment: mp && t.requirePayment !== false,
      minSpendPerGuest: money(ctx.settings.reservation?.minSpendPerGuestCents || 0), holdMinutes: ctx.settings.reservation?.holdMinutes ?? 15, durationMinutes: ctx.settings.reservation?.durationMinutes || 90, lockMinutes: ctx.settings.reservation?.lockMinutes ?? 30 },
    rooms: { enabled: !!accOn, depositRequired: !!dep.required },
    mpesa: mp, requireAccount: REQUIRE_ACCOUNT, holdMinutes: HOLD_MIN,
    googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
    googleMapsKey: process.env.GOOGLE_MAPS_KEY || undefined,
  };
}

/** Menu with prep time per dish and the list of current offers (happy hour / promo prices). */
async function menu(token, { branchId } = {}) {
  const r = await open(token); const b = await pickBranch(r, branchId);
  const m = await G.menuFor({ businessId: r.businessId, branchId: b._id, ctx: r.ctx, orderType: 'DELIVERY' });
  const ids = m.categories.flatMap((c) => c.items.map((i) => i.id));
  const prep = new Map((await MenuItem.find({ _id: { $in: ids } }).select('prepMinutes')).map((x) => [String(x._id), x.prepMinutes]));
  const categories = m.categories.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, prepMinutes: prep.get(String(i.id)) ?? 10 })) }));
  const offers = categories.flatMap((c) => c.items.filter((i) => i.promoLabel && i.available !== false).map((i) => ({ ...i, category: c.name })));
  return { currency: m.currency, branchId: b._id, categories, offers };
}

// ------------------------------------------------------------------ delivery
async function deliveryQuote(token, { branchId, lat, lng, subtotal }) {
  const r = await open(token); const d = r.store.delivery || {}; const b = await pickBranch(r, branchId);
  if (d.enabled === false || d.paused) throw ApiError.conflict('Delivery is paused right now. You can still reserve a table.', 'DELIVERY_PAUSED');
  const t = S.deliveryTerms(d, { from: pointOf(r.store, b._id), to: { lat, lng }, subtotalCents: Math.round((subtotal || 0) * 100) });
  return { ok: t.ok, code: t.code, reason: t.reason, distanceKm: t.distanceKm, fee: money(t.feeCents), minOrder: money(t.minOrderCents), etaMinutes: S.etaMinutes(d, { prepMinutes: [], distanceKm: t.distanceKm }) };
}

async function placeDelivery(token, body, account) {
  const r = await open(token); const { ctx, store: st } = r; const d = st.delivery || {};
  needAccount(account);
  if (d.enabled === false || d.paused) throw ApiError.conflict('Delivery is paused right now. Please try again later.', 'DELIVERY_PAUSED');
  if (!S.withinHours(new Date(), ctx.timeZone, d.hoursStart, d.hoursEnd)) throw ApiError.conflict(`We deliver between ${d.hoursStart} and ${d.hoursEnd}.`, 'DELIVERY_CLOSED');
  const b = await pickBranch(r, body.branchId);
  const phone = S.kePhone(body.phone); if (!phone) throw ApiError.badRequest('Enter a valid phone number, for example 0712 345 678', 'INVALID_PHONE');
  if (!S.validPoint({ lat: body.lat, lng: body.lng })) throw ApiError.badRequest('Please pin your delivery location on the map', 'NO_LOCATION');
  const mp = await mpesaOn(r.businessId); const cashOk = (d.payment || 'MPESA_OR_CASH') !== 'MPESA' || !mp;
  const method = body.payMethod || (mp ? 'MPESA' : 'CASH');
  if (method === 'MPESA' && !mp) throw ApiError.badRequest('Paying by M-PESA is not set up here. Please choose cash on delivery.', 'MPESA_NOT_ENABLED');
  if (method === 'CASH' && !cashOk) throw ApiError.badRequest('Please pay with M-PESA - cash on delivery is not offered.', 'CASH_NOT_ALLOWED');
  const recent = await RestaurantOrder.countDocuments({ businessId: r.businessId, source: 'ONLINE', customerPhone: phone, createdAt: { $gt: new Date(Date.now() - 10 * 60000) }, status: { $ne: 'CANCELLED' } });
  if (recent >= 3) throw ApiError.conflict('You already have several orders in progress. Please wait a few minutes.', 'TOO_MANY_ORDERS');
  const terms = S.deliveryTerms(d, { from: pointOf(st, b._id), to: { lat: body.lat, lng: body.lng } });
  if (!terms.ok) throw ApiError.badRequest(terms.reason, terms.code);
  const actor = await C.guestActor(r.businessId); const trackKey = S.newKey();
  const { order, replayed } = await orders.createOrder(r.businessId, actor, {
    branchId: b._id, orderType: 'DELIVERY', source: 'ONLINE', guestCount: 1, customerName: body.name, customerPhone: phone, notes: body.notes,
    clientRef: `web-${body.clientRef}`, deviceId: 'web', _guest: true,
    delivery: { contactName: body.name, phone, address: body.address, landmark: body.landmark, instructions: body.instructions, fee: terms.feeCents, lat: Number(body.lat), lng: Number(body.lng), distanceKm: terms.distanceKm, mapsUrl: S.mapsLink(body.lat, body.lng), payment: method, trackKey, online: true },
  });
  if (replayed) return trackFull(order);
  let sb;
  try {
    const raw = body.items.map((i, k) => ({ menuItemId: i.menuItemId, quantity: i.quantity, variantId: i.variantId, modifiers: i.modifiers, comboPicks: i.comboPicks, notes: i.notes, clientItemId: `web-${order._id}-${k}` }));
    const res = await orders.addItems(r.businessId, actor, order._id, { items: raw, sendNow: false });
    const rc = await RC.getContext(r.businessId);
    const lt = liveTotalsSync(res.order, rc);
    const foodTotal = lt.itemsTotal - (terms.feeCents || 0);          // the minimum order is about the food, not the delivery fee
    if (d.minOrderCents && foodTotal < d.minOrderCents) throw ApiError.badRequest(`The minimum delivery order is KSh ${(d.minOrderCents / 100).toFixed(0)}.`, 'BELOW_MINIMUM');
    const prep = (await MenuItem.find({ _id: { $in: body.items.map((i) => i.menuItemId) } }).select('prepMinutes')).map((x) => x.prepMinutes || 0);
    const eta = S.etaMinutes(d, { prepMinutes: prep, distanceKm: terms.distanceKm });
    const total = lt.total;
    if (!(total > 0)) throw ApiError.badRequest('Your order total could not be worked out. Please check your items and try again.', 'ORDER_TOTAL_ZERO');
    await RestaurantOrder.updateOne({ _id: order._id }, { $set: { 'delivery.etaMinutes': eta, totals: { itemsTotal: lt.itemsTotal, serviceCharge: lt.serviceCharge, tax: lt.tax, total: lt.total, discount: lt.discount } } });
    sb = await StoreBooking.create({ businessId: r.businessId, accountId: account && account._id, kind: 'ORDER', refId: order._id, reference: trackKey, phone, payState: method === 'MPESA' ? 'AWAITING' : 'COD', amountDue: method === 'MPESA' ? total : 0, payBy: method === 'MPESA' ? new Date(Date.now() + HOLD_MIN * 60000) : undefined });
    // M-PESA: the kitchen starts only once the money is in (see settle). Cash on delivery: as before.
    if (method === 'CASH' && (d.mode || 'AUTO') === 'AUTO') await orders.sendOrder(r.businessId, actor, order._id, {});
  } catch (e) { await RestaurantOrder.deleteOne({ _id: order._id, status: 'OPEN' }); if (sb) await StoreBooking.deleteOne({ _id: sb._id }); throw e; }   // nothing half-made is left on the POS
  const fresh = await RestaurantOrder.findById(order._id);
  if (method === 'CASH') notify(r, b, [...STAFF, 'RECEPTIONIST'], `New delivery order ${fresh.orderNumber}`, `${body.name} (${phone}) - ${body.address}. Cash on delivery. Open Delivery to ${(d.mode || 'AUTO') === 'AUTO' ? 'assign a rider' : 'confirm and send it to the kitchen'}.`, 'RestaurantOrder', fresh._id);
  return trackView(fresh, sb, await RC.getContext(r.businessId));
}

function trackView(o, sb, rc) {
  const dl = o.delivery || {}; const live = o.items.filter((i) => i.status !== 'CANCELLED' && !i.parentItemId);
  const drafts = live.length && live.every((i) => i.status === 'DRAFT');
  const kitchen = G.stageOf(o);
  const awaiting = !!sb && sb.payState === 'AWAITING';
  const stage = o.status === 'CANCELLED' ? 'CANCELLED' : awaiting ? 'AWAITING_PAYMENT' : dl.status === 'DELIVERED' ? 'DELIVERED' : dl.status === 'OUT_FOR_DELIVERY' ? 'ON_THE_WAY' : dl.status === 'FAILED' ? 'FAILED' : drafts ? 'RECEIVED' : kitchen === 'READY' || kitchen === 'SERVED' ? 'READY' : kitchen === 'PREPARING' ? 'PREPARING' : kitchen === 'CONFIRMED' ? 'CONFIRMED' : 'RECEIVED';
  const state = sb ? sb.payState : (dl.payment === 'MPESA' ? 'PAID' : 'COD');
  const owed = rc ? liveTotalsSync(o, rc).total : (o.totals && o.totals.total);
  return {
    trackKey: dl.trackKey, orderNumber: o.orderNumber, stage, placedAt: o.createdAt, etaMinutes: dl.etaMinutes, address: dl.address, payment: dl.payment || 'CASH',
    pay: { method: dl.payment || 'CASH', state, amountDue: money(awaiting ? owed : (sb ? sb.amountDue : 0)), payBy: sb && sb.payBy, receiptRef: sb && sb.receiptRef || null },
    rider: dl.riderName ? { name: dl.riderName } : null, deliveredAt: dl.deliveredAt, failReason: dl.failReason, total: money(owed),
    items: live.map((i) => ({ name: i.name, quantity: i.quantity, total: money(i.total != null ? i.total : (i.unitPrice || 0) * i.quantity) })),
    message: ({ AWAITING_PAYMENT: 'Waiting for your M-PESA payment. Your order is held for a few minutes.', RECEIVED: 'We have your order.', CONFIRMED: 'Your order is confirmed.', PREPARING: 'The kitchen is preparing your food.', READY: 'Your food is ready and waiting for the rider.', ON_THE_WAY: 'Your rider is on the way.', DELIVERED: 'Delivered. Enjoy your meal!', CANCELLED: state === 'EXPIRED' ? 'This order was released because it was not paid in time.' : 'This order was cancelled.', FAILED: 'We could not deliver this order. Please call us.' })[stage],
  };
}
const trackFull = async (o) => {
  const view = trackView(o, await StoreBooking.findOne({ businessId: o.businessId, kind: 'ORDER', refId: o._id }), await RC.getContext(o.businessId));
  // live rider block (position, distance, ETA, alerts, steps). Old pages ignore it; the new tracking screen draws it.
  if (o.delivery && o.delivery.trackKey && o.delivery.riderId) { try { view.live = await require('../delivery/tracking.service').customerLive(o.businessId, o.delivery.trackKey); } catch (e) { /* tracking is a bonus: never break the order page */ } }
  return view;
};
async function track(token, trackKey) {
  const r = await open(token);
  const o = await RestaurantOrder.findOne({ businessId: r.businessId, 'delivery.trackKey': String(trackKey) });
  if (!o) throw ApiError.notFound('We could not find that order.', 'ORDER_NOT_FOUND'); return trackFull(o);
}
/** STK push for a delivery order placed with "pay with M-PESA". */
async function orderPayStart(token, trackKey, { payerPhone }) {
  const r = await open(token); const bid = r.businessId;
  const ph = S.kePhone(payerPhone); if (!ph) throw ApiError.badRequest('Enter a valid Safaricom number', 'INVALID_PHONE');
  if (!(await mpesaOn(bid))) throw ApiError.badRequest('Paying online is not set up here.', 'MPESA_NOT_ENABLED');
  const o = await RestaurantOrder.findOne({ businessId: bid, 'delivery.trackKey': String(trackKey) });
  const sb = o && await StoreBooking.findOne({ businessId: bid, kind: 'ORDER', refId: o._id });
  if (!o || !sb) throw ApiError.notFound('We could not find that order.', 'ORDER_NOT_FOUND');
  if (sb.payState === 'PAID') throw ApiError.conflict('This order is already paid.', 'ALREADY_PAID');
  if (sb.payState !== 'AWAITING' || o.status === 'CANCELLED') throw ApiError.conflict('This order is no longer waiting for payment. Please place it again.', 'NOT_PAYABLE');
  const amount = (await liveTotals(o)).total || 0; if (!(amount > 0)) throw ApiError.conflict('Nothing is due.', 'NOTHING_TO_PAY');
  if (sb.amountDue !== amount) await StoreBooking.updateOne({ _id: sb._id }, { $set: { amountDue: amount } });     // heals orders saved with a wrong amount
  const again = await MpesaTransaction.findOne({ businessId: bid, 'storePay.refId': o._id, status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 90000) } });
  if (again && again.amount === amount) return { reference: again.reference, amount: money(amount), reused: true };
  const actor = await C.guestActor(bid);
  const txn = await mpesa.initiateStk(bid, o.branchId, actor, { phone: ph, amountCents: amount, customerName: o.customerName || 'Customer' });
  await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { storePay: { kind: 'ORDER', refId: o._id, accountId: sb.accountId } } });
  await StoreBooking.updateOne({ _id: sb._id }, { $set: { payBy: new Date(Date.now() + HOLD_MIN * 60000) } });     // the hold restarts while a prompt is out
  return { reference: txn.reference, amount: money(amount) };
}

// ------------------------------------------------------------------ tables
async function tables(token, { branchId, date, time, partySize = 1 }) {
  const r = await open(token); const b = await pickBranch(r, branchId); const t = r.store.tables || {}; const rs = r.ctx.settings.reservation || {};
  const dur = rs.durationMinutes || 90; const tz = r.ctx.timeZone;
  const startsAt = date && time ? S.zonedDate(date, time, tz) : new Date();
  const endsAt = new Date(startsAt.getTime() + dur * 60000); const isNow = startsAt.getTime() - Date.now() < 30 * 60000;
  const dayStart = date ? S.zonedDate(date, '00:00', tz) : new Date(); const dayEnd = new Date(dayStart.getTime() + 86400000);
  const [list, areas, dayBookings] = await Promise.all([
    RestaurantTable.find({ businessId: r.businessId, branchId: b._id, active: true, combinedInto: null }).sort({ name: 1 }).collation({ locale: 'en', numericOrdering: true }),
    RestaurantArea.find({ businessId: r.businessId, branchId: b._id }).select('name'),
    Reservation.find({ businessId: r.businessId, branchId: b._id, status: { $in: RESERVATION_ACTIVE }, startsAt: { $lt: dayEnd }, endsAt: { $gt: dayStart } }).select('tableIds startsAt endsAt'),
  ]);
  const clash = (x) => x.startsAt < endsAt && x.endsAt > startsAt;
  const taken = new Set(dayBookings.filter(clash).flatMap((x) => x.tableIds.map(String)));
  const times = new Map();            // table -> the times it is already booked on that day, so the guest can see when it is free
  for (const x of dayBookings) for (const id of x.tableIds) { const k = String(id); if (!times.has(k)) times.set(k, []); times.get(k).push({ from: x.startsAt, to: x.endsAt }); }
  const an = new Map(areas.map((a) => [String(a._id), a.name]));
  const slots = date ? S.reservationSlots(date, { ...t, durationMinutes: dur, timeZone: tz }).map((s) => s.time) : [];
  return {
    durationMinutes: dur, slots, depositRequired: !!rs.depositRequired, deposit: money(rs.depositCents || 0), minSpendPerGuest: money(rs.minSpendPerGuestCents || 0),
    tables: list.map((x) => {
      const soon = startsAt.getTime() < Date.now() + dur * 60000;          // the party seated now is still there during this slot
      const inUse = x.status !== 'AVAILABLE' || !!x.currentOrderId;
      const reserved = taken.has(String(x._id)) || (soon && x.status === 'RESERVED'); const occupied = (isNow || soon) && inUse && x.status !== 'RESERVED';
      const small = x.seats < partySize;
      return { id: x._id, name: x.name, seats: x.seats, area: an.get(String(x.areaId)), free: !reserved && !occupied && !small, reason: reserved ? 'RESERVED' : occupied ? 'OCCUPIED' : small ? 'TOO_SMALL' : null, booked: (times.get(String(x._id)) || []).sort((p, q) => p.from - q.from) };
    }),
  };
}

async function reserveTable(token, body, account) {
  const r = await open(token); const st = r.store.tables || {}; const rs = r.ctx.settings.reservation || {};
  needAccount(account);
  if (r.ctx.features.tables === false || st.enabled === false) throw ApiError.forbidden('Table booking is not available here.', 'TABLES_DISABLED');
  const b = await pickBranch(r, body.branchId); const phone = S.kePhone(body.phone); if (!phone) throw ApiError.badRequest('Enter a valid phone number, for example 0712 345 678', 'INVALID_PHONE');
  const startsAt = S.zonedDate(body.date, body.time, r.ctx.timeZone);
  const bad = S.slotProblem(startsAt, st, { timeZone: r.ctx.timeZone }); if (bad) throw ApiError.badRequest(bad, 'SLOT_NOT_ALLOWED');
  if (rs.maxNoShows > 0) {            // a number that keeps missing its bookings is asked to call us instead
    const missed = await Reservation.countDocuments({ businessId: r.businessId, phoneKey: phone.slice(-9), status: 'NO_SHOW' });
    if (missed >= rs.maxNoShows) throw ApiError.forbidden('Online booking is not available for this number. Please call us to book a table.', 'NO_SHOW_BLOCKED');
  }
  const actor = await C.guestActor(r.businessId);
  const pre = []; let preText = ''; let preCents = 0;
  if (body.preOrder && body.preOrder.length) {
    const m = await G.menuFor({ businessId: r.businessId, branchId: b._id, ctx: r.ctx, orderType: 'DINE_IN' });
    const byId = new Map(m.categories.flatMap((c) => c.items).map((i) => [String(i.id), i]));
    for (const i of body.preOrder) {
      const it = byId.get(String(i.menuItemId));
      if (!it || it.available === false) throw ApiError.badRequest('A dish you chose is no longer available', 'MENU_ITEM_NOT_FOUND');
      if (it.price == null) throw ApiError.badRequest(`${it.name} needs a size - please order it with delivery or at the table.`, 'PREORDER_VARIANT');
      pre.push({ menuItemId: i.menuItemId, name: it.name, quantity: i.quantity, notes: i.notes }); preCents += Math.round(it.price * 100) * i.quantity;
    }
    preText = `PRE-ORDER: ${pre.map((i) => `${i.quantity}x ${i.name}${i.notes ? ` (${i.notes})` : ''}`).join(', ')}`;
  }
  // The table is only really booked once it is paid: the food pre-order if there is one, otherwise the owner's table deposit.
  const mp = await mpesaOn(r.businessId); const mustPay = mp && st.requirePayment !== false;
  // What the guest pays now: the food they will eat (chosen dishes, or an amount they decide), never less than the owner's minimum per guest.
  const creditCents = Math.round((Number(body.foodCredit) || 0) * 100); const minCents = (rs.minSpendPerGuestCents || 0) * body.partySize;
  const foodCents = Math.max(preCents, creditCents);
  if (mustPay && minCents > 0 && foodCents < minCents) throw ApiError.badRequest(`To book for ${body.partySize}, please pay at least KSh ${money(minCents)} towards your food (KSh ${money(rs.minSpendPerGuestCents)} per person).`, 'MIN_SPEND');
  const due = foodCents > 0 ? foodCents : (rs.depositRequired ? rs.depositCents || 0 : 0);
  if (mustPay && !(due > 0)) throw ApiError.badRequest('Choose how much food to prepay, or pick dishes - your table is confirmed once it is paid with M-PESA.', 'PREORDER_REQUIRED');
  const rv = await reservations.create(r.businessId, actor, {
    branchId: b._id, guestName: body.name, phone, partySize: body.partySize, startsAt, tableIds: [body.tableId], source: 'ONLINE', occasion: body.occasion,
    notes: [body.notes, preText].filter(Boolean).join(' | ') || undefined, ...(mustPay ? { depositAmount: due, depositKind: foodCents > 0 ? 'FOOD' : 'DEPOSIT' } : {}),
  });
  if (pre.length) await Reservation.updateOne({ _id: rv._id }, { $set: { preOrder: pre } });
  const awaiting = mustPay && due > 0;
  await StoreBooking.create({ businessId: r.businessId, accountId: account && account._id, kind: 'RESERVATION', refId: rv._id, reference: rv.reservationNumber, phone, payState: awaiting ? 'AWAITING' : 'NONE', amountDue: awaiting ? due : 0, payBy: awaiting ? new Date(Date.now() + HOLD_MIN * 60000) : undefined });
  if (!awaiting) { const tb = await RestaurantTable.findById(body.tableId).select('name'); notify(r, b, [...STAFF, 'RECEPTIONIST'], `Online reservation ${rv.reservationNumber}`, `Table ${tb ? tb.name : ''} for ${body.partySize} on ${body.date} at ${body.time} - ${body.name} (${phone})${pre.length ? `. Pre-order: ${pre.length} dish(es).` : ''}`, 'Reservation', rv._id); }
  return resFull(await Reservation.findById(rv._id));
}
const RES_MSG = { BOOKED: 'Your table is booked. We will confirm shortly.', CONFIRMED: 'Your table is confirmed.', ARRIVED: 'Welcome! Your table is ready.', SEATED: 'Enjoy your meal.', CANCELLED: 'This booking was cancelled.', NO_SHOW: 'This booking was marked as missed.', COMPLETED: 'Thank you for visiting.' };
async function resFull(x) {
  const [sb, tbs] = await Promise.all([StoreBooking.findOne({ businessId: x.businessId, kind: 'RESERVATION', refId: x._id }), RestaurantTable.find({ _id: { $in: x.tableIds } }).select('name seats')]);
  const awaiting = !!sb && sb.payState === 'AWAITING';
  return { reference: x.reservationNumber, status: x.status, guestName: x.guestName, partySize: x.partySize, startsAt: x.startsAt, tables: tbs.map((t) => ({ name: t.name, seats: t.seats })), preOrder: x.preOrder, phone: x.phone,
    deposit: { required: !!x.deposit?.required, amount: money(x.deposit?.amount || 0), paid: !!x.deposit?.paid, kind: x.deposit?.kind || 'DEPOSIT', used: money(x.deposit?.appliedAmount || 0), forfeited: !!x.deposit?.forfeited, refunded: !!x.deposit?.refunded },
    canCancel: RESERVATION_ACTIVE.includes(x.status) && !!x.startsAt && x.startsAt.getTime() > Date.now() + 60 * 60000, pay: { state: sb ? sb.payState : 'NONE', payBy: sb && sb.payBy, receiptRef: sb && sb.receiptRef || null },
    message: awaiting ? 'Pay with M-PESA to confirm your table. It is held for a few minutes.' : sb && sb.payState === 'EXPIRED' ? 'This table was released because it was not paid in time.' : RES_MSG[x.status] };
}
async function reservationLookup(token, { reference, phone }) {
  const r = await open(token);
  const x = await Reservation.findOne({ businessId: r.businessId, reservationNumber: String(reference || '').toUpperCase() });
  if (!x || S.last4(x.phone) !== S.last4(phone)) throw ApiError.notFound('We could not find a booking with those details.', 'BOOKING_NOT_FOUND'); return resFull(x);
}

/** The guest cancels their own table booking (up to an hour before). Prepaid money is not returned automatically: the manager is told to refund it. */
async function cancelReservation(token, { reference, phone }, account) {
  const r = await open(token);
  const x = await Reservation.findOne({ businessId: r.businessId, reservationNumber: String(reference || '').toUpperCase() });
  const sb = x && await StoreBooking.findOne({ businessId: r.businessId, kind: 'RESERVATION', refId: x._id });
  const owns = !!(account && sb && sb.accountId && String(sb.accountId) === String(account._id));
  if (!x || !(owns || S.last4(x.phone) === S.last4(phone))) throw ApiError.notFound('We could not find a booking with those details.', 'BOOKING_NOT_FOUND');
  if (!RESERVATION_ACTIVE.includes(x.status)) throw ApiError.conflict('This booking can no longer be cancelled.', 'NOT_CANCELLABLE');
  if (x.startsAt && x.startsAt.getTime() < Date.now() + 60 * 60000) throw ApiError.conflict('It is too close to your booking time to cancel online. Please call us.', 'TOO_LATE');
  const actor = await C.guestActor(r.businessId);
  await reservations.setStatus(r.businessId, actor, x._id, { status: 'CANCELLED', reason: 'Cancelled by the guest' });
  if (sb && sb.payState === 'AWAITING') await StoreBooking.updateOne({ _id: sb._id }, { $set: { payState: 'EXPIRED' } });
  const tb = await RestaurantTable.find({ _id: { $in: x.tableIds } }).select('name');
  notify(r, x.branchId, [...STAFF, 'RECEPTIONIST'], `Booking cancelled ${x.reservationNumber}`, `${x.guestName} cancelled table ${tb.map((t) => t.name).join(', ')}. The table is free again.${x.deposit && x.deposit.paid ? ' They had prepaid: please refund or keep it.' : ''}`, 'Reservation', x._id);
  return resFull(await Reservation.findById(x._id));
}

// ------------------------------------------------------------------ rooms
async function rooms(token, { branchId, checkInDate, checkOutDate, adults = 1, children = 0 }) {
  const r = await open(token); const { ctx } = r;
  if (!ctx.features.accommodation || r.store.rooms?.enabled === false) throw ApiError.forbidden('Rooms are not available here.', 'ROOMS_DISABLED');
  const b = await pickBranch(r, branchId); const actor = await C.guestActor(r.businessId);
  const av = await stays.availability(r.businessId, actor, { branchId: b._id, checkInDate, checkOutDate, adults, children });
  const types = new Map((await RoomType.find({ businessId: r.businessId, active: true })).map((t) => [String(t._id), t]));
  const out = [];
  for (const g of av.byType) {
    const t = types.get(String(g.roomTypeId)); if (!t) continue;
    const sample = av.rooms.find((x) => String(x.roomTypeId) === String(g.roomTypeId));
    if (!sample || !sample.quote || sample.quote.error) continue;
    const first = sample.quote.nightly[0] ? sample.quote.nightly[0].amount : 0;
    const dep = R.depositDue(ctx.acc, { firstNightAmount: first, total: sample.quote.total }) || 0;
    const live = !!(t.promo && t.promo.active && t.promo.percentOff > 0);
    out.push({ roomTypeId: t._id, name: t.name, description: t.description, images: t.images, amenities: t.amenities, bedConfig: t.bedConfig, maxAdults: t.maxAdults, maxChildren: t.maxChildren, available: g.available, nights: sample.quote.nights, total: money(sample.quote.total), perNight: money(first), deposit: money(dep), promo: live ? { title: t.promo.title, percentOff: t.promo.percentOff } : null });
  }
  return { branchId: b._id, checkInDate, checkOutDate, depositNote: ctx.acc?.deposit?.required ? 'A deposit secures your room.' : null, roomTypes: out };
}

async function bookRoom(token, body, account) {
  const r = await open(token); const { ctx } = r;
  needAccount(account);
  if (!ctx.features.accommodation || r.store.rooms?.enabled === false) throw ApiError.forbidden('Rooms are not available here.', 'ROOMS_DISABLED');
  const b = await pickBranch(r, body.branchId); const phone = S.kePhone(body.phone); if (!phone) throw ApiError.badRequest('Enter a valid phone number, for example 0712 345 678', 'INVALID_PHONE');
  const actor = await C.guestActor(r.businessId);
  const out = await stays.reserve(r.businessId, actor, { branchId: b._id, roomTypeId: body.roomTypeId, checkInDate: body.checkInDate, checkOutDate: body.checkOutDate, guest: { name: body.name, phone, email: body.email || (account && account.email) }, adults: body.adults || 1, children: body.children || 0, mealPlan: body.mealPlan, source: 'ONLINE', specialRequests: body.specialRequests, clientRef: `web-${body.clientRef}` });
  const s = out.stay; const dep = s.depositRequired || 0; const mp = await mpesaOn(r.businessId); const awaiting = mp && dep > 0;
  await StoreBooking.updateOne({ businessId: r.businessId, kind: 'STAY', refId: s._id }, { $setOnInsert: { accountId: account && account._id, reference: s.bookingCode, phone, payState: awaiting ? 'AWAITING' : 'NONE', amountDue: awaiting ? dep : 0, payBy: awaiting ? new Date(Date.now() + STAY_HOLD_MIN * 60000) : undefined } }, { upsert: true });
  if (!out.replayed && !awaiting) notify(r, b, [...FRONT], `Online room booking ${s.stayNumber}`, `${body.name} (${phone}) booked ${s.roomTypeName} room ${s.roomNumber}, ${body.checkInDate} to ${body.checkOutDate}. ${dep ? `Deposit KSh ${money(dep)} expected.` : 'No deposit required.'} Prepare the room.`, 'Stay', s._id);
  return stayView(s, await StoreBooking.findOne({ businessId: r.businessId, kind: 'STAY', refId: s._id }));
}
const paidDeposit = (s) => (s.payments || []).filter((p) => !p.verifyStatus || p.verifyStatus !== 'REJECTED').reduce((a, p) => a + (p.kind === 'REFUND' ? -p.amount : p.kind === 'DEPOSIT' ? p.amount : 0), 0);
function stayView(s, sb) {
  const need = s.depositRequired || 0; const paid = paidDeposit(s); const expired = !!sb && sb.payState === 'EXPIRED';
  return { bookingCode: s.bookingCode, stayNumber: s.stayNumber, status: s.status, roomType: s.roomTypeName, roomNumber: s.roomNumber, checkInDate: s.checkInDate, checkOutDate: s.checkOutDate, nights: s.nights, guestName: s.guest && s.guest.name, total: money(s.totals && s.totals.total), deposit: { required: need > 0, amount: money(need), paid: money(paid), due: money(Math.max(0, need - paid)) }, pay: { state: sb ? sb.payState : 'NONE', payBy: sb && sb.payBy, receiptRef: sb && sb.receiptRef || null },
    message: expired ? 'This booking was released because the deposit was not paid in time.' : ({ RESERVED: need > paid ? 'Booked. Pay the deposit to secure your room.' : 'Your room is booked and secured.', CHECKED_IN: 'You are checked in. Enjoy your stay.', CHECKED_OUT: 'Thank you for staying with us.', CANCELLED: 'This booking was cancelled.', NO_SHOW: 'This booking was marked as missed.' })[s.status] };
}
async function bookingLookup(token, { code, phone }) {
  const r = await open(token);
  const s = await Stay.findOne({ businessId: r.businessId, bookingCode: String(code || '').toUpperCase() });
  if (!s || S.last4(s.guest && s.guest.phone) !== S.last4(phone)) throw ApiError.notFound('We could not find a booking with those details.', 'BOOKING_NOT_FOUND');
  return stayView(s, await StoreBooking.findOne({ businessId: r.businessId, kind: 'STAY', refId: s._id }));
}

// ------------------------------------------------------------------ deposits for tables / rooms (M-PESA STK, applied by the server even if the phone closes the page)
async function depositStart(token, { kind, ref, phone, payerPhone }, account) {
  const r = await open(token); const bid = r.businessId; const ph = S.kePhone(payerPhone || phone); if (!ph) throw ApiError.badRequest('Enter a valid Safaricom number', 'INVALID_PHONE');
  if (!(await mpesaOn(bid))) throw ApiError.badRequest('Paying online is not set up here. Please pay at the venue or call us.', 'MPESA_NOT_ENABLED');
  let doc; let amount; let branchId; let name; const model = kind === 'STAY' ? 'STAY' : 'RESERVATION';
  if (kind === 'STAY') doc = await Stay.findOne({ businessId: bid, bookingCode: String(ref).toUpperCase() });
  else doc = await Reservation.findOne({ businessId: bid, reservationNumber: String(ref).toUpperCase() });
  const sb = doc && await StoreBooking.findOne({ businessId: bid, kind: model, refId: doc._id });
  const owns = !!(account && sb && sb.accountId && String(sb.accountId) === String(account._id));
  const lastOk = doc && S.last4(kind === 'STAY' ? doc.guest.phone : doc.phone) === S.last4(phone);
  if (!doc || !(owns || lastOk)) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
  if (kind === 'STAY') {
    if (doc.status !== 'RESERVED') throw ApiError.conflict('This booking is not waiting for a deposit.', 'NOT_PAYABLE');
    amount = Math.max(0, (doc.depositRequired || 0) - paidDeposit(doc)); branchId = doc.branchId; name = doc.guest.name;
  } else {
    if (!RESERVATION_ACTIVE.includes(doc.status) || !doc.deposit?.required || doc.deposit.paid) throw ApiError.conflict('This booking has no payment due.', 'NOT_PAYABLE');
    amount = doc.deposit.amount; branchId = doc.branchId; name = doc.guestName;
  }
  if (sb && sb.payState === 'EXPIRED') throw ApiError.conflict('This booking was released. Please book again.', 'EXPIRED');
  if (!(amount > 0)) throw ApiError.conflict('Nothing is due.', 'NOTHING_TO_PAY');
  const actor = await C.guestActor(bid);
  const again = await MpesaTransaction.findOne({ businessId: bid, 'storePay.refId': doc._id, status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 90000) } });
  if (again && again.amount === amount) return { reference: again.reference, amount: money(amount), reused: true };
  const txn = await mpesa.initiateStk(bid, branchId, actor, { phone: ph, amountCents: amount, customerName: name });
  await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { storePay: { kind: model, refId: doc._id, accountId: sb && sb.accountId } } });
  if (sb && sb.payState === 'AWAITING') await StoreBooking.updateOne({ _id: sb._id }, { $set: { payBy: new Date(Date.now() + (kind === 'STAY' ? STAY_HOLD_MIN : HOLD_MIN) * 60000) } });
  return { reference: txn.reference, amount: money(amount) };
}

// ---- e-receipts
const fmtN = (c) => (Math.round(c) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function buildReceipt(txn, ctx) {
  const b = ctx.business; const rs = b.receiptSettings || {}; const k = txn.storePay.kind;
  const head = { currency: b.currency, business: { name: b.name, address: b.address, phone: b.phone, taxPin: b.kraPin || b.taxPin, logo: rs.showLogo ? b.logo : undefined }, mpesaReceipt: txn.mpesaReceiptNumber || null, phone: txn.phone, footer: rs.footerMessage || 'Thank you for choosing us!', paid: true, date: txn.updatedAt, number: txn.mpesaReceiptNumber || txn.reference, total: money(txn.amount), paidAmount: money(txn.amount), balance: 0, payments: [{ method: 'M-PESA', amount: money(txn.amount), reference: txn.mpesaReceiptNumber || txn.reference }] };
  if (k === 'ORDER') {
    const o = await RestaurantOrder.findById(txn.storePay.refId); const bill = o && await RestaurantBill.findOne({ orderId: o._id, status: { $ne: 'VOID' } }).sort({ createdAt: -1 });
    const lines = bill ? bill.lines.filter((l) => !l.isComp).map((l) => ({ name: [l.name, l.variantName && `(${l.variantName})`].filter(Boolean).join(' '), note: l.modifiersText, quantity: l.quantity, total: money(l.total) })) : (o ? o.items.filter((i) => i.status !== 'CANCELLED' && !i.parentItemId).map((i) => ({ name: i.name, quantity: i.quantity, total: null })) : []);
    return { ...head, kind: 'ORDER', place: `Delivery ${o ? o.orderNumber : ''}`, title: 'Receipt', billNumber: bill && bill.billNumber, number: (bill && bill.receiptNumber) || head.number, lines, itemsTotal: bill ? money(bill.itemsTotal) : undefined, serviceCharge: bill ? money(bill.serviceCharge) : undefined, tax: bill ? money(bill.tax) : undefined, total: bill ? money(bill.total) : head.total };
  }
  if (k === 'RESERVATION') {
    const x = await Reservation.findById(txn.storePay.refId); const tbs = x ? await RestaurantTable.find({ _id: { $in: x.tableIds } }).select('name') : [];
    return { ...head, kind: 'RESERVATION', place: `Table ${tbs.map((t) => t.name).join(', ')}`, title: 'Table booking receipt', lines: [{ name: `${x && x.preOrder && x.preOrder.length ? 'Pre-ordered food' : 'Table deposit'} - ${x ? x.reservationNumber : ''}`, note: x && x.preOrder && x.preOrder.length ? x.preOrder.map((i) => `${i.quantity}x ${i.name}`).join(', ') : undefined, quantity: 1, total: money(txn.amount) }] };
  }
  const s = await Stay.findById(txn.storePay.refId);
  return { ...head, kind: 'STAY', place: s ? `${s.roomTypeName} ${s.checkInDate} to ${s.checkOutDate}` : 'Room booking', title: 'Deposit receipt', lines: [{ name: `Room deposit - booking ${s ? s.bookingCode : ''}`, quantity: 1, total: money(txn.amount) }] };
}
async function saveReceipt(txn, ctx) {
  try {
    const rc = await buildReceipt(txn, ctx);
    await GuestReceipt.updateOne({ businessId: txn.businessId, reference: txn.reference }, { $setOnInsert: { businessId: txn.businessId, reference: txn.reference, accountId: txn.storePay.accountId, placeKey: String(txn.businessId), kind: txn.storePay.kind === 'RESERVATION' ? 'RESERVATION' : txn.storePay.kind, number: rc.number, total: rc.total, paidAmount: rc.paidAmount, paid: true, snapshot: rc } }, { upsert: true });
  } catch (e) { console.error('[storefront] could not save receipt:', e.message); }
}
async function receipt(token, req, reference) {
  const r = await open(token); const a = await acct.fromRequest(req, r.businessId);
  const q = a ? { businessId: r.businessId, accountId: a._id, reference } : null;
  let rc = q && await GuestReceipt.findOne(q);
  if (!rc) {
    const phone = req.query && req.query.phone;
    if (/^(BILL|DESK)-/.test(reference)) {      // paid at the till / to the rider: found with the phone number the order was placed with
      rc = await GuestReceipt.findOne({ businessId: r.businessId, reference });
      if (!rc || !phone || !rc.snapshot || S.last4(rc.snapshot.phone) !== S.last4(phone)) throw ApiError.notFound('Receipt not found', 'RECEIPT_NOT_FOUND');
    } else {
      const txn = await MpesaTransaction.findOne({ businessId: r.businessId, reference });
      if (!txn || !txn.storePay || !txn.storePay.kind || !phone || S.last4(txn.phone) !== S.last4(phone)) throw ApiError.notFound('Receipt not found', 'RECEIPT_NOT_FOUND');
      rc = await GuestReceipt.findOne({ businessId: r.businessId, reference });
      if (!rc) throw ApiError.notFound('Receipt not found', 'RECEIPT_NOT_FOUND');
    }
  }
  return rc.snapshot;
}

// ---- payments taken by STAFF (cashier till, rider, front desk): the customer's profile gets the receipt and shows PAID
const PAY_LABEL = { CASH: 'Cash', MPESA: 'M-PESA', MOBILE_MONEY: 'Mobile money', CARD: 'Card', BANK: 'Bank transfer' };
const payLine = (p) => ({ method: PAY_LABEL[p.method] || p.method, amount: money(p.amount), reference: p.reference });
async function businessHead(businessId) {
  const ctx = await C.getContext(businessId); const b = ctx.business; const rs = b.receiptSettings || {};
  return { currency: b.currency, business: { name: b.name, address: b.address, phone: b.phone, taxPin: b.kraPin || b.taxPin, logo: rs.showLogo ? b.logo : undefined }, footer: rs.footerMessage || 'Thank you for choosing us!' };
}
async function saveDeskBillReceipt(sb, bill) {
  const pays = (bill.payments || []).filter((p) => p.kind === 'PAYMENT'); const mp = pays.find((p) => p.method === 'MPESA');
  const reference = `BILL-${bill._id}-${sb.accountId || sb._id}`; const head = await businessHead(sb.businessId);
  const o = await RestaurantOrder.findById(bill.orderId).select('orderNumber');
  const rc = { ...head, place: `Delivery ${(o && o.orderNumber) || bill.orderNumber || ''}`.trim(), mpesaReceipt: (mp && mp.reference) || null, phone: sb.phone, kind: 'ORDER', paid: true, paidAtDesk: true, title: 'Receipt',
    number: bill.receiptNumber || bill.billNumber, billNumber: bill.billNumber, date: bill.settledAt || new Date(),
    lines: bill.lines.filter((l) => !l.isComp).map((l) => ({ name: [l.name, l.variantName && `(${l.variantName})`].filter(Boolean).join(' '), note: l.modifiersText, quantity: l.quantity, total: money(l.total) })),
    itemsTotal: money(bill.itemsTotal), discount: money(bill.discount), serviceCharge: money(bill.serviceCharge), tax: money(bill.tax), total: money(bill.total), paidAmount: money(bill.paid), balance: money(bill.balance), payments: pays.map(payLine) };
  await GuestReceipt.updateOne({ businessId: sb.businessId, reference }, { $setOnInsert: { businessId: sb.businessId, reference, accountId: sb.accountId, placeKey: String(sb.businessId), kind: 'ORDER', number: rc.number, total: rc.total, paidAmount: rc.paidAmount, paid: true, snapshot: rc } }, { upsert: true });
  return reference;
}
/** Called when a restaurant bill becomes PAID (cash at the till, cash given to the rider, card, till number...). Idempotent. */
async function onBillPaid(bill) {
  try {
    if (!bill || bill.status !== 'PAID') return;
    const sb = await StoreBooking.findOne({ businessId: bill.businessId, kind: 'ORDER', refId: bill.orderId }); if (!sb) return;
    const pays = (bill.payments || []).filter((p) => p.kind === 'PAYMENT'); const refs = pays.map((p) => p.reference).filter(Boolean);
    if (refs.length && await MpesaTransaction.exists({ businessId: bill.businessId, reference: { $in: refs }, 'storePay.kind': 'ORDER' })) return;   // paid with the storefront STK push: settle() makes that receipt
    const reference = await saveDeskBillReceipt(sb, bill);
    const open = await RestaurantBill.exists({ orderId: bill.orderId, status: { $in: ['OPEN', 'PARTIAL'] } });
    const set = { receiptRef: reference }; if (!open) { set.payState = 'PAID'; set.amountDue = 0; }
    await StoreBooking.updateOne({ _id: sb._id, payState: { $in: ['COD', 'AWAITING', 'NONE', 'PAID'] } }, { $set: set });
  } catch (e) { console.error('[storefront] could not save desk receipt:', e.message); }
}
/** A table deposit or room deposit recorded by staff (cash / till). method, amount (cents), reference. */
async function onDeskPayment(kind, doc, { method, amount, reference }) {
  try {
    const bid = doc.businessId; const sb = await StoreBooking.findOne({ businessId: bid, kind, refId: doc._id }); if (!sb) return;
    if (method === 'MPESA' && await MpesaTransaction.exists({ businessId: bid, 'storePay.refId': doc._id, status: 'SUCCESS' })) return;     // storefront STK push: settle() handles it
    const fresh = kind === 'STAY' ? await Stay.findById(doc._id) : await Reservation.findById(doc._id); if (!fresh) return;
    const done = kind === 'STAY' ? paidDeposit(fresh) >= (fresh.depositRequired || 0) : !!(fresh.deposit && fresh.deposit.paid);
    const ref = `DESK-${doc._id}-${sb.accountId || sb._id}`; const head = await businessHead(bid);
    const stayLine = kind === 'STAY' ? `Room deposit - booking ${fresh.bookingCode}` : `${fresh.preOrder && fresh.preOrder.length ? 'Pre-ordered food' : 'Table deposit'} - ${fresh.reservationNumber}`;
    const rc = { ...head, phone: sb.phone, kind, paid: true, paidAtDesk: true, title: kind === 'STAY' ? 'Deposit receipt' : 'Table booking receipt', number: `DEP-${sb.reference}`, date: new Date(),
      place: kind === 'STAY' ? `${fresh.roomTypeName} ${fresh.checkInDate} to ${fresh.checkOutDate}` : 'Table booking', lines: [{ name: stayLine, quantity: 1, total: money(amount) }], total: money(amount), paidAmount: money(amount), balance: 0, payments: [payLine({ method, amount, reference })] };
    await GuestReceipt.updateOne({ businessId: bid, reference: ref }, { $setOnInsert: { businessId: bid, reference: ref, accountId: sb.accountId, placeKey: String(bid), kind, number: rc.number, total: rc.total, paidAmount: rc.paidAmount, paid: true, snapshot: rc } }, { upsert: true });
    const set = { receiptRef: ref }; if (done) { set.payState = 'PAID'; set.amountDue = 0; }
    await StoreBooking.updateOne({ _id: sb._id, payState: { $in: ['AWAITING', 'NONE', 'COD', 'PAID'] } }, { $set: set });
  } catch (e) { console.error('[storefront] could not save desk deposit receipt:', e.message); }
}
/** For the signed-in customer: orders already paid at the till / to the rider (before this fix) get their receipt now. Idempotent. */
async function backfillDesk(businessId, account) {
  try {
    const sbs = await StoreBooking.find({ businessId, accountId: account._id, kind: 'ORDER', payState: { $in: ['COD', 'AWAITING'] } }).sort({ createdAt: -1 }).limit(30);
    for (const sb of sbs) { const paid = await RestaurantBill.find({ orderId: sb.refId, status: 'PAID' }); for (const b of paid) await onBillPaid(b); }
  } catch (e) { console.error('[storefront] desk backfill failed:', e.message); }
}

// ---- settle once the money is in
async function settle(txn) {
  const claim = await MpesaTransaction.findOneAndUpdate({ _id: txn._id, 'storePay.settledAt': { $exists: false } }, { $set: { 'storePay.settledAt': new Date() } });
  if (!claim) return;
  try {
    const bid = txn.businessId; const actor = await C.guestActor(bid); const ctx = await C.getAccContext(bid); const k = txn.storePay.kind; const refId = txn.storePay.refId;
    const sb = await StoreBooking.findOne({ businessId: bid, kind: k, refId });
    const late = !!sb && sb.payState === 'EXPIRED';
    const text = (title, message, branchId, entityType, entityId) => ({ type: 'GUEST_PAYMENT', title, message, branchId, entityType, entityId });
    if (k === 'ORDER') {
      const o = await RestaurantOrder.findById(refId);
      if (!o || o.status === 'CANCELLED') { C.notifyManagement(bid, { type: 'GUEST_PAYMENT_PROBLEM', title: 'A delivery order was paid after it was released', message: `M-PESA ${txn.mpesaReceiptNumber || txn.reference} (KSh ${money(txn.amount)}) arrived for a cancelled order. Please refund the customer or recreate the order.`, entityType: 'MpesaTransaction', entityId: txn._id }); }
      else {
        await orders.sendOrder(bid, actor, o._id, {});                                   // paid: the kitchen starts now
        try { await bills.generateBill(bid, actor, o._id, {}); } catch (e) { if (!/NOTHING_TO_BILL/.test(e.code || e.message || '')) throw e; }
        const bill = await RestaurantBill.findOne({ orderId: o._id, status: { $in: ['OPEN', 'PARTIAL'] } }).sort({ createdAt: 1 });
        if (bill && !txn.restaurantBillId) await bills.pay(bid, actor, bill._id, { payments: [{ method: 'MPESA', amount: txn.amount, reference: txn.reference }] });
        const d = (ctx.settings.storefront && ctx.settings.storefront.delivery) || {};
        const t = text(`Paid delivery order ${o.orderNumber}`, `${o.customerName} paid KSh ${money(txn.amount)} by M-PESA (${txn.mpesaReceiptNumber || ''}). ${(d.mode || 'AUTO') === 'AUTO' ? 'Assign a rider.' : 'Check and send it to the kitchen.'}`, o.branchId, 'RestaurantOrder', o._id);
        C.notifyRoles(bid, o.branchId, [...STAFF, 'RECEPTIONIST'], t); C.notifyManagement(bid, t);
      }
    } else if (k === 'STAY') {
      await folio.addPayment(bid, actor, refId, { kind: 'DEPOSIT', method: 'MPESA', amount: txn.amount, reference: txn.mpesaReceiptNumber || txn.reference, payerPhone: txn.phone });
      const s = await Stay.findById(refId).select('stayNumber branchId guest.name roomTypeName roomNumber checkInDate checkOutDate');
      if (s) C.notifyRoles(bid, s.branchId, FRONT, text(`Deposit paid ${s.stayNumber}`, `${s.guest.name} paid KSh ${money(txn.amount)} by M-PESA (${txn.mpesaReceiptNumber || ''}). ${s.roomTypeName} ${s.checkInDate} to ${s.checkOutDate} is secured. Prepare the room.`, s.branchId, 'Stay', s._id));
    } else {
      const x = await Reservation.findOneAndUpdate({ _id: refId, 'deposit.paid': false }, { $set: { 'deposit.paid': true, 'deposit.method': 'MPESA', 'deposit.reference': txn.mpesaReceiptNumber, status: 'CONFIRMED' } }, { new: true });
      if (x) C.notifyRoles(bid, x.branchId, [...STAFF, 'RECEPTIONIST'], text(`Table paid ${x.reservationNumber}`, `${x.guestName} paid KSh ${money(txn.amount)} by M-PESA. Table booking confirmed${x.preOrder && x.preOrder.length ? `. Pre-order: ${x.preOrder.map((i) => `${i.quantity}x ${i.name}`).join(', ')}` : ''}.`, x.branchId, 'Reservation', x._id));
    }
    if (late) C.notifyManagement(bid, { type: 'GUEST_PAYMENT_PROBLEM', title: 'A booking was paid after its hold ran out', message: `M-PESA ${txn.mpesaReceiptNumber || txn.reference} (KSh ${money(txn.amount)}) arrived after the hold expired. Check the booking and honour or refund it.`, entityType: 'MpesaTransaction', entityId: txn._id });
    await StoreBooking.updateOne({ businessId: bid, kind: k, refId }, { $set: { payState: 'PAID', receiptRef: txn.reference } });
    await saveReceipt(txn, ctx);
  } catch (e) { await MpesaTransaction.updateOne({ _id: txn._id }, { $unset: { 'storePay.settledAt': 1 }, $set: { 'storePay.error': String(e.message).slice(0, 200) } }); console.error('[storefront] settle failed:', e.message); }
}
const settleByTxn = async (id) => { try { const t = await MpesaTransaction.findById(id); if (t && t.status === 'SUCCESS' && t.storePay && t.storePay.kind) await settle(t); } catch (e) { console.error('[storefront] settleByTxn failed:', e.message); } };
async function depositStatus(token, reference) {
  const r = await open(token); const s = await mpesa.getStatus(r.businessId, reference);
  const txn = await MpesaTransaction.findOne({ businessId: r.businessId, reference });
  if (!txn || !txn.storePay || !txn.storePay.kind) throw ApiError.notFound('Payment not found', 'NOT_FOUND');
  if (txn.status === 'SUCCESS') await settle(txn);
  const fresh = await MpesaTransaction.findById(txn._id);
  return { status: s.status, message: s.message, receipt: s.mpesaReceiptNumber, reference, kind: txn.storePay.kind, settled: !!(fresh.storePay && fresh.storePay.settledAt), failureType: s.failureType || null };
}

// ---- the customer's account: everything they placed, with receipts
async function history(token, req) {
  const r = await open(token); const a = await acct.fromRequest(req, r.businessId); if (!a) throw ApiError.unauthorized('Please sign in to continue', 'GUEST_AUTH_REQUIRED');
  await backfillDesk(r.businessId, a);       // cash taken by a cashier / rider before this fix still gets its receipt
  const sbs = await StoreBooking.find({ businessId: r.businessId, accountId: a._id }).sort({ createdAt: -1 }).limit(80);
  const ids = (k) => sbs.filter((x) => x.kind === k).map((x) => x.refId); const by = (arr) => new Map(arr.map((d) => [String(d._id), d]));
  const [os, rs, ss, rc] = await Promise.all([RestaurantOrder.find({ _id: { $in: ids('ORDER') } }), Reservation.find({ _id: { $in: ids('RESERVATION') } }), Stay.find({ _id: { $in: ids('STAY') } }),
    GuestReceipt.find({ businessId: r.businessId, accountId: a._id }).sort({ createdAt: -1 }).limit(60).select('reference number total paidAmount kind createdAt snapshot.place')]);
  const rcx = await RC.getContext(r.businessId); const om = by(os); const rm = by(rs); const sm = by(ss); const orders = []; const reservationsOut = []; const staysOut = [];
  for (const sb of sbs) {
    if (sb.kind === 'ORDER' && om.get(String(sb.refId))) orders.push({ ...trackView(om.get(String(sb.refId)), sb, rcx), at: sb.createdAt });
    else if (sb.kind === 'RESERVATION' && rm.get(String(sb.refId))) reservationsOut.push({ ...(await resFull(rm.get(String(sb.refId)))), at: sb.createdAt });
    else if (sb.kind === 'STAY' && sm.get(String(sb.refId))) staysOut.push({ ...stayView(sm.get(String(sb.refId)), sb), at: sb.createdAt });
  }
  return { account: acct.view(a), orders, reservations: reservationsOut, stays: staysOut, receipts: rc.map((x) => ({ reference: x.reference, number: x.number, total: x.total, paid: x.paidAmount, kind: x.kind, place: x.snapshot && x.snapshot.place, at: x.createdAt })) };
}

// ---- background: finish payments whose phone went away, release what was never paid
async function expireUnpaid() {
  const now = new Date(); const list = await StoreBooking.find({ payState: 'AWAITING', payBy: { $lt: now } }).limit(60);
  for (const sb of list) {
    try {
      const paid = await MpesaTransaction.findOne({ businessId: sb.businessId, 'storePay.refId': sb.refId, status: 'SUCCESS' });
      if (paid) { await settle(paid); continue; }
      const waiting = await MpesaTransaction.exists({ businessId: sb.businessId, 'storePay.refId': sb.refId, status: 'PENDING', createdAt: { $gt: new Date(now.getTime() - 3 * 60000) } }); if (waiting) continue;
      const got = await StoreBooking.findOneAndUpdate({ _id: sb._id, payState: 'AWAITING' }, { $set: { payState: 'EXPIRED' } }); if (!got) continue;
      const actor = await C.guestActor(sb.businessId);
      if (sb.kind === 'ORDER') { try { await orders.cancelOrder(sb.businessId, actor, sb.refId, { reason: 'Not paid in time' }); } catch (e) { await RestaurantOrder.deleteOne({ _id: sb.refId, status: 'OPEN' }); } }
      else if (sb.kind === 'RESERVATION') await Reservation.updateOne({ _id: sb.refId, status: 'BOOKED', 'deposit.paid': false }, { $set: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'Not paid in time' } });
      else { try { await stays.cancel(sb.businessId, actor, sb.refId, { reason: 'Deposit not paid in time', waiveFee: true }); } catch (e) { console.error('[storefront] could not release stay:', e.message); } }
    } catch (e) { console.error('[storefront] expire failed:', e.message); }
  }
}
async function sweep() {
  const list = await MpesaTransaction.find({ 'storePay.kind': { $exists: true }, 'storePay.settledAt': { $exists: false }, status: 'SUCCESS', updatedAt: { $gt: new Date(Date.now() - 6 * 3600000) } }).limit(50);
  for (const t of list) await settle(t);
  await expireUnpaid();
}

module.exports = { context, menu, accountFrom, deliveryQuote, placeDelivery, track, orderPayStart, tables, reserveTable, reservationLookup, cancelReservation, rooms, bookRoom, bookingLookup, depositStart, depositStatus, receipt, history, settleByTxn, sweep, onBillPaid, onDeskPayment, open };