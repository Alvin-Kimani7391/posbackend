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
const reservations = require('../restaurant/reservation.service');
const stays = require('../hospitality/stay.service');
const folio = require('../hospitality/folio.service');
const mpesa = require('../mpesa.service');

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

// ------------------------------------------------------------------ context + menu
async function context(token) {
  const r = await open(token); const { ctx, store: st } = r;
  const branches = await branchesOf(r.businessId); const d = st.delivery || {}; const t = st.tables || {};
  const now = new Date(); const accOn = ctx.features.accommodation && st.rooms?.enabled !== false;
  const dep = ctx.acc?.deposit || {};
  return {
    business: { name: ctx.business.name, logo: ctx.business.logo, phone: ctx.business.phone, currency: ctx.business.currency || 'KES', timezone: ctx.timeZone, address: ctx.business.address },
    store: { tagline: st.tagline, welcomeMessage: st.welcomeMessage, themeColor: st.themeColor || '#0f766e' },
    branches: branches.map((b) => ({ id: b._id, name: b.name, phone: b.phone, address: b.address, hasPin: !!pointOf(st, b._id), location: pointOf(st, b._id) })),
    delivery: { enabled: d.enabled !== false, paused: !!d.paused, openNow: S.withinHours(now, ctx.timeZone, d.hoursStart, d.hoursEnd), hours: d.hoursStart && d.hoursEnd ? `${d.hoursStart} - ${d.hoursEnd}` : null, baseFee: money(d.baseFeeCents), perKm: money(d.perKmCents), minOrder: money(d.minOrderCents), maxRadiusKm: d.maxRadiusKm || null },
    tables: { enabled: ctx.features.tables !== false && t.enabled !== false, openTime: t.openTime || '10:00', closeTime: t.closeTime || '22:00', depositRequired: !!ctx.settings.reservation?.depositRequired, deposit: money(ctx.settings.reservation?.depositCents || 0) },
    rooms: { enabled: !!accOn, depositRequired: !!dep.required },
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

async function placeDelivery(token, body) {
  const r = await open(token); const { ctx, store: st } = r; const d = st.delivery || {};
  if (d.enabled === false || d.paused) throw ApiError.conflict('Delivery is paused right now. Please try again later.', 'DELIVERY_PAUSED');
  if (!S.withinHours(new Date(), ctx.timeZone, d.hoursStart, d.hoursEnd)) throw ApiError.conflict(`We deliver between ${d.hoursStart} and ${d.hoursEnd}.`, 'DELIVERY_CLOSED');
  const b = await pickBranch(r, body.branchId);
  const phone = S.kePhone(body.phone); if (!phone) throw ApiError.badRequest('Enter a valid phone number, for example 0712 345 678', 'INVALID_PHONE');
  if (!S.validPoint({ lat: body.lat, lng: body.lng })) throw ApiError.badRequest('Please pin your delivery location on the map', 'NO_LOCATION');
  const recent = await RestaurantOrder.countDocuments({ businessId: r.businessId, source: 'ONLINE', customerPhone: phone, createdAt: { $gt: new Date(Date.now() - 10 * 60000) }, status: { $ne: 'CANCELLED' } });
  if (recent >= 3) throw ApiError.conflict('You already have several orders in progress. Please wait a few minutes.', 'TOO_MANY_ORDERS');
  const terms = S.deliveryTerms(d, { from: pointOf(st, b._id), to: { lat: body.lat, lng: body.lng } });
  if (!terms.ok) throw ApiError.badRequest(terms.reason, terms.code);
  const actor = await C.guestActor(r.businessId); const trackKey = S.newKey();
  const { order, replayed } = await orders.createOrder(r.businessId, actor, {
    branchId: b._id, orderType: 'DELIVERY', source: 'ONLINE', guestCount: 1, customerName: body.name, customerPhone: phone, notes: body.notes,
    clientRef: `web-${body.clientRef}`, deviceId: 'web', _guest: true,
    delivery: { contactName: body.name, phone, address: body.address, landmark: body.landmark, instructions: body.instructions, fee: terms.feeCents, lat: Number(body.lat), lng: Number(body.lng), distanceKm: terms.distanceKm, mapsUrl: S.mapsLink(body.lat, body.lng), payment: 'CASH', trackKey, online: true },
  });
  if (replayed) return trackView(order);
  try {
    const raw = body.items.map((i, k) => ({ menuItemId: i.menuItemId, quantity: i.quantity, variantId: i.variantId, modifiers: i.modifiers, comboPicks: i.comboPicks, notes: i.notes, clientItemId: `web-${order._id}-${k}` }));
    const res = await orders.addItems(r.businessId, actor, order._id, { items: raw, sendNow: false });
    const itemsTotal = (res.order.totals && res.order.totals.itemsTotal) || 0;
    if (d.minOrderCents && itemsTotal < d.minOrderCents) throw ApiError.badRequest(`The minimum delivery order is KSh ${(d.minOrderCents / 100).toFixed(0)}.`, 'BELOW_MINIMUM');
    const prep = (await MenuItem.find({ _id: { $in: body.items.map((i) => i.menuItemId) } }).select('prepMinutes')).map((x) => x.prepMinutes || 0);
    const eta = S.etaMinutes(d, { prepMinutes: prep, distanceKm: terms.distanceKm });
    await RestaurantOrder.updateOne({ _id: order._id }, { $set: { 'delivery.etaMinutes': eta } });
    if ((d.mode || 'AUTO') === 'AUTO') await orders.sendOrder(r.businessId, actor, order._id, {});
  } catch (e) { await RestaurantOrder.deleteOne({ _id: order._id, status: 'OPEN' }); throw e; }   // nothing half-made is left on the POS
  const fresh = await RestaurantOrder.findById(order._id);
  notify(r, b, [...STAFF, 'RECEPTIONIST'], `New delivery order ${fresh.orderNumber}`, `${body.name} (${phone}) - ${body.address}. Open Delivery to ${(d.mode || 'AUTO') === 'AUTO' ? 'assign a rider' : 'confirm and send it to the kitchen'}.`, 'RestaurantOrder', fresh._id);
  return trackView(fresh);
}

function trackView(o) {
  const dl = o.delivery || {}; const live = o.items.filter((i) => i.status !== 'CANCELLED' && !i.parentItemId);
  const drafts = live.length && live.every((i) => i.status === 'DRAFT');
  const kitchen = G.stageOf(o);
  const stage = o.status === 'CANCELLED' ? 'CANCELLED' : dl.status === 'DELIVERED' ? 'DELIVERED' : dl.status === 'OUT_FOR_DELIVERY' ? 'ON_THE_WAY' : dl.status === 'FAILED' ? 'FAILED' : drafts ? 'RECEIVED' : kitchen === 'READY' || kitchen === 'SERVED' ? 'READY' : kitchen === 'PREPARING' ? 'PREPARING' : kitchen === 'CONFIRMED' ? 'CONFIRMED' : 'RECEIVED';
  return {
    trackKey: dl.trackKey, orderNumber: o.orderNumber, stage, placedAt: o.createdAt, etaMinutes: dl.etaMinutes, address: dl.address, payment: dl.payment || 'CASH',
    rider: dl.riderName ? { name: dl.riderName } : null, deliveredAt: dl.deliveredAt, failReason: dl.failReason, total: money(o.totals && o.totals.total),
    items: live.map((i) => ({ name: i.name, quantity: i.quantity })), message: ({ RECEIVED: 'We have your order.', CONFIRMED: 'Your order is confirmed.', PREPARING: 'The kitchen is preparing your food.', READY: 'Your food is ready and waiting for the rider.', ON_THE_WAY: 'Your rider is on the way.', DELIVERED: 'Delivered. Enjoy your meal!', CANCELLED: 'This order was cancelled.', FAILED: 'We could not deliver this order. Please call us.' })[stage],
  };
}
async function track(token, trackKey) {
  const r = await open(token);
  const o = await RestaurantOrder.findOne({ businessId: r.businessId, 'delivery.trackKey': String(trackKey) });
  if (!o) throw ApiError.notFound('We could not find that order.', 'ORDER_NOT_FOUND'); return trackView(o);
}

// ------------------------------------------------------------------ tables
async function tables(token, { branchId, date, time, partySize = 1 }) {
  const r = await open(token); const b = await pickBranch(r, branchId); const t = r.store.tables || {}; const rs = r.ctx.settings.reservation || {};
  const dur = rs.durationMinutes || 90;
  const startsAt = date && time ? S.zonedDate(date, time, r.ctx.timeZone) : new Date();
  const endsAt = new Date(startsAt.getTime() + dur * 60000); const isNow = startsAt.getTime() - Date.now() < 30 * 60000;
  const [list, areas, busy] = await Promise.all([
    RestaurantTable.find({ businessId: r.businessId, branchId: b._id, active: true }).sort({ name: 1 }),
    RestaurantArea.find({ businessId: r.businessId, branchId: b._id }).select('name'),
    Reservation.find({ businessId: r.businessId, branchId: b._id, status: { $in: RESERVATION_ACTIVE }, startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt } }).select('tableIds'),
  ]);
  const taken = new Set(busy.flatMap((x) => x.tableIds.map(String))); const an = new Map(areas.map((a) => [String(a._id), a.name]));
  const slots = date ? S.reservationSlots(date, { ...t, durationMinutes: dur, timeZone: r.ctx.timeZone }).map((s) => s.time) : [];
  return {
    durationMinutes: dur, slots, depositRequired: !!rs.depositRequired, deposit: money(rs.depositCents || 0),
    tables: list.map((x) => {
      const reserved = taken.has(String(x._id)); const occupied = isNow && x.status !== 'AVAILABLE';
      const small = x.seats < partySize;
      return { id: x._id, name: x.name, seats: x.seats, area: an.get(String(x.areaId)), free: !reserved && !occupied && !small, reason: reserved ? 'RESERVED' : occupied ? 'OCCUPIED' : small ? 'TOO_SMALL' : null };
    }),
  };
}

async function reserveTable(token, body) {
  const r = await open(token); const st = r.store.tables || {}; const rs = r.ctx.settings.reservation || {};
  if (r.ctx.features.tables === false || st.enabled === false) throw ApiError.forbidden('Table booking is not available here.', 'TABLES_DISABLED');
  const b = await pickBranch(r, body.branchId); const phone = S.kePhone(body.phone); if (!phone) throw ApiError.badRequest('Enter a valid phone number, for example 0712 345 678', 'INVALID_PHONE');
  const startsAt = S.zonedDate(body.date, body.time, r.ctx.timeZone);
  const bad = S.slotProblem(startsAt, st, { timeZone: r.ctx.timeZone }); if (bad) throw ApiError.badRequest(bad, 'SLOT_NOT_ALLOWED');
  const actor = await C.guestActor(r.businessId);
  const pre = []; let preText = '';
  if (body.preOrder && body.preOrder.length) {
    const items = await MenuItem.find({ businessId: r.businessId, _id: { $in: body.preOrder.map((i) => i.menuItemId) }, status: 'active' }).select('name');
    const nm = new Map(items.map((i) => [String(i._id), i.name]));
    for (const i of body.preOrder) { if (!nm.has(String(i.menuItemId))) throw ApiError.badRequest('A dish you chose is no longer on the menu', 'MENU_ITEM_NOT_FOUND'); pre.push({ menuItemId: i.menuItemId, name: nm.get(String(i.menuItemId)), quantity: i.quantity, notes: i.notes }); }
    preText = `PRE-ORDER: ${pre.map((i) => `${i.quantity}x ${i.name}${i.notes ? ` (${i.notes})` : ''}`).join(', ')}`;
  }
  const rv = await reservations.create(r.businessId, actor, {
    branchId: b._id, guestName: body.name, phone, partySize: body.partySize, startsAt, tableIds: [body.tableId], source: 'ONLINE', occasion: body.occasion,
    notes: [body.notes, preText].filter(Boolean).join(' | ') || undefined,
  });
  if (pre.length) await Reservation.updateOne({ _id: rv._id }, { $set: { preOrder: pre } });
  const tb = await RestaurantTable.findById(body.tableId).select('name');
  notify(r, b, [...STAFF, 'RECEPTIONIST'], `Online reservation ${rv.reservationNumber}`, `Table ${tb ? tb.name : ''} for ${body.partySize} on ${body.date} at ${body.time} - ${body.name} (${phone})${pre.length ? `. Pre-order: ${pre.length} dish(es), start preparing in time.` : ''}`, 'Reservation', rv._id);
  return reservationView(await Reservation.findById(rv._id));
}
const reservationView = (x) => ({ reference: x.reservationNumber, status: x.status, guestName: x.guestName, partySize: x.partySize, startsAt: x.startsAt, tableIds: x.tableIds, preOrder: x.preOrder, deposit: { required: !!x.deposit?.required, amount: money(x.deposit?.amount || 0), paid: !!x.deposit?.paid }, message: ({ BOOKED: 'Your table is booked. We will confirm shortly.', CONFIRMED: 'Your table is confirmed.', ARRIVED: 'Welcome! Your table is ready.', SEATED: 'Enjoy your meal.', CANCELLED: 'This booking was cancelled.', NO_SHOW: 'This booking was marked as missed.', COMPLETED: 'Thank you for visiting.' })[x.status] });
async function reservationLookup(token, { reference, phone }) {
  const r = await open(token);
  const x = await Reservation.findOne({ businessId: r.businessId, reservationNumber: String(reference || '').toUpperCase() });
  if (!x || S.last4(x.phone) !== S.last4(phone)) throw ApiError.notFound('We could not find a booking with those details.', 'BOOKING_NOT_FOUND'); return reservationView(x);
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

async function bookRoom(token, body) {
  const r = await open(token); const { ctx } = r;
  if (!ctx.features.accommodation || r.store.rooms?.enabled === false) throw ApiError.forbidden('Rooms are not available here.', 'ROOMS_DISABLED');
  const b = await pickBranch(r, body.branchId); const phone = S.kePhone(body.phone); if (!phone) throw ApiError.badRequest('Enter a valid phone number, for example 0712 345 678', 'INVALID_PHONE');
  const actor = await C.guestActor(r.businessId);
  const out = await stays.reserve(r.businessId, actor, { branchId: b._id, roomTypeId: body.roomTypeId, checkInDate: body.checkInDate, checkOutDate: body.checkOutDate, guest: { name: body.name, phone, email: body.email }, adults: body.adults || 1, children: body.children || 0, mealPlan: body.mealPlan, source: 'ONLINE', specialRequests: body.specialRequests, clientRef: `web-${body.clientRef}` });
  const s = out.stay;
  if (!out.replayed) notify(r, b, [...FRONT], `Online room booking ${s.stayNumber}`, `${body.name} (${phone}) booked ${s.roomTypeName} room ${s.roomNumber}, ${body.checkInDate} to ${body.checkOutDate}. Deposit ${money(s.depositRequired || 0) ? `KSh ${money(s.depositRequired)} expected` : 'not required'}. Prepare the room.`, 'Stay', s._id);
  return stayView(s);
}
const paidDeposit = (s) => (s.payments || []).filter((p) => !p.verifyStatus || p.verifyStatus !== 'REJECTED').reduce((a, p) => a + (p.kind === 'REFUND' ? -p.amount : p.kind === 'DEPOSIT' ? p.amount : 0), 0);
function stayView(s) {
  const need = s.depositRequired || 0; const paid = paidDeposit(s);
  return { bookingCode: s.bookingCode, stayNumber: s.stayNumber, status: s.status, roomType: s.roomTypeName, checkInDate: s.checkInDate, checkOutDate: s.checkOutDate, nights: s.nights, guestName: s.guest && s.guest.name, total: money(s.totals && s.totals.total), deposit: { required: need > 0, amount: money(need), paid: money(paid), due: money(Math.max(0, need - paid)) }, message: ({ RESERVED: need > paid ? 'Booked. Pay the deposit to secure your room.' : 'Your room is booked and secured.', CHECKED_IN: 'You are checked in. Enjoy your stay.', CHECKED_OUT: 'Thank you for staying with us.', CANCELLED: 'This booking was cancelled.', NO_SHOW: 'This booking was marked as missed.' })[s.status] };
}
async function bookingLookup(token, { code, phone }) {
  const r = await open(token);
  const s = await Stay.findOne({ businessId: r.businessId, bookingCode: String(code || '').toUpperCase() });
  if (!s || S.last4(s.guest && s.guest.phone) !== S.last4(phone)) throw ApiError.notFound('We could not find a booking with those details.', 'BOOKING_NOT_FOUND'); return stayView(s);
}

// ------------------------------------------------------------------ deposits (M-PESA STK, applied by the server even if the phone closes the page)
async function depositStart(token, { kind, ref, phone, payerPhone }) {
  const r = await open(token); const bid = r.businessId; const ph = S.kePhone(payerPhone || phone); if (!ph) throw ApiError.badRequest('Enter a valid Safaricom number', 'INVALID_PHONE');
  const on = await IntegrationSettings.findOne({ businessId: bid }).select('mpesa.enabled mpesa.channelId');
  if (!on || !on.mpesa || !on.mpesa.enabled) throw ApiError.badRequest('Paying online is not set up here. Please pay at the venue or call us.', 'MPESA_NOT_ENABLED');
  let doc; let amount; let branchId; let name;
  if (kind === 'STAY') {
    doc = await Stay.findOne({ businessId: bid, bookingCode: String(ref).toUpperCase() });
    if (!doc || S.last4(doc.guest.phone) !== S.last4(phone)) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
    if (!['RESERVED'].includes(doc.status)) throw ApiError.conflict('This booking is not waiting for a deposit.', 'NOT_PAYABLE');
    amount = Math.max(0, (doc.depositRequired || 0) - paidDeposit(doc)); branchId = doc.branchId; name = doc.guest.name;
  } else {
    doc = await Reservation.findOne({ businessId: bid, reservationNumber: String(ref).toUpperCase() });
    if (!doc || S.last4(doc.phone) !== S.last4(phone)) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
    if (!RESERVATION_ACTIVE.includes(doc.status) || !doc.deposit?.required || doc.deposit.paid) throw ApiError.conflict('This booking has no deposit to pay.', 'NOT_PAYABLE');
    amount = doc.deposit.amount; branchId = doc.branchId; name = doc.guestName;
  }
  if (!(amount > 0)) throw ApiError.conflict('Nothing is due.', 'NOTHING_TO_PAY');
  const actor = await C.guestActor(bid);
  const again = await MpesaTransaction.findOne({ businessId: bid, 'storePay.refId': doc._id, status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 90000) } });
  if (again && again.amount === amount) return { reference: again.reference, amount: money(amount), reused: true };
  const txn = await mpesa.initiateStk(bid, branchId, actor, { phone: ph, amountCents: amount, customerName: name });
  await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { storePay: { kind: kind === 'STAY' ? 'STAY' : 'RESERVATION', refId: doc._id } } });
  return { reference: txn.reference, amount: money(amount) };
}
async function settle(txn) {
  const claim = await MpesaTransaction.findOneAndUpdate({ _id: txn._id, 'storePay.settledAt': { $exists: false } }, { $set: { 'storePay.settledAt': new Date() } });
  if (!claim) return;
  try {
    const bid = txn.businessId; const actor = await C.guestActor(bid);
    if (txn.storePay.kind === 'STAY') {
      await folio.addPayment(bid, actor, txn.storePay.refId, { kind: 'DEPOSIT', method: 'MPESA', amount: txn.amount, reference: txn.mpesaReceiptNumber, payerPhone: txn.phone });
      const s = await Stay.findById(txn.storePay.refId).select('stayNumber branchId guest.name');
      if (s) C.notifyRoles(bid, s.branchId, FRONT, { type: 'GUEST_PAYMENT', title: `Deposit paid ${s.stayNumber}`, message: `${s.guest.name} paid KSh ${money(txn.amount)} by M-PESA (${txn.mpesaReceiptNumber || ''}).`, branchId: s.branchId, entityType: 'Stay', entityId: s._id });
    } else {
      const x = await Reservation.findOneAndUpdate({ _id: txn.storePay.refId, 'deposit.paid': false }, { $set: { 'deposit.paid': true, 'deposit.method': 'MPESA', 'deposit.reference': txn.mpesaReceiptNumber, status: 'CONFIRMED' } }, { new: true });
      if (x) C.notifyRoles(bid, x.branchId, [...STAFF, 'RECEPTIONIST'], { type: 'GUEST_PAYMENT', title: `Deposit paid ${x.reservationNumber}`, message: `${x.guestName} paid KSh ${money(txn.amount)} by M-PESA. Table booking confirmed.`, branchId: x.branchId, entityType: 'Reservation', entityId: x._id });
    }
  } catch (e) { await MpesaTransaction.updateOne({ _id: txn._id }, { $unset: { 'storePay.settledAt': 1 }, $set: { 'storePay.error': String(e.message).slice(0, 200) } }); console.error('[storefront] deposit settle failed:', e.message); }
}
async function depositStatus(token, reference) {
  const r = await open(token); const s = await mpesa.getStatus(r.businessId, reference);
  const txn = await MpesaTransaction.findOne({ businessId: r.businessId, reference });
  if (!txn || !txn.storePay || !txn.storePay.kind) throw ApiError.notFound('Payment not found', 'NOT_FOUND');
  if (txn.status === 'SUCCESS') await settle(txn);
  return { status: s.status, message: s.message, receipt: s.mpesaReceiptNumber };
}
async function sweep() {
  const list = await MpesaTransaction.find({ 'storePay.kind': { $exists: true }, 'storePay.settledAt': { $exists: false }, status: 'SUCCESS', updatedAt: { $gt: new Date(Date.now() - 6 * 3600000) } }).limit(50);
  for (const t of list) await settle(t);
}

module.exports = { context, menu, deliveryQuote, placeDelivery, track, tables, reserveTable, reservationLookup, rooms, bookRoom, bookingLookup, depositStart, depositStatus, sweep };
