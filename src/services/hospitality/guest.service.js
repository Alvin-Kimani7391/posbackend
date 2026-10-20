/**
 * What a guest does after scanning a QR code: read the menu, send an order, follow it, call a waiter, ask for the bill,
 * and (in a room) see the folio, check in or out. No login: the signed QR token identifies the table or room, and a
 * room also needs the PIN from the registration card. Every action is limited by the owner's guest-ordering settings.
 */
const crypto = require('crypto');
const GuestRequest = require('../../models/GuestRequest');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantTable = require('../../models/RestaurantTable');
const MenuItem = require('../../models/MenuItem');
const ModifierGroup = require('../../models/ModifierGroup');
const Branch = require('../../models/Branch');
const Stay = require('../../models/Stay');
const ApiError = require('../../utils/ApiError');
const P = require('../../utils/restaurantPricing');
const T = require('../../utils/hospitalityTime');
const menuSvc = require('../restaurant/menu.service');
const orders = require('../restaurant/order.service');
const stays = require('./stay.service');
const folio = require('./folio.service');
const calls = require('./servicecall.service');
const qr = require('./qr.service');
const C = require('./common');

const ORDERING = ['ORDER_CONFIRM', 'ORDER_AUTO'];
const TABLE_CALLS = ['WAITER', 'BILL', 'ASSISTANCE', 'OTHER'];
const ROOM_CALLS = ['WAITER', 'CLEANING', 'HOUSEKEEPING', 'MAINTENANCE', 'RECEPTION', 'ASSISTANCE', 'OTHER'];
const hashIp = (ip) => crypto.createHash('sha256').update(`${ip || ''}:${process.env.QR_SECRET || 'x'}`).digest('hex').slice(0, 24);
const money = (c) => (c === null || c === undefined ? null : Math.round(c) / 100);

async function place(token, { pin, needStay = false, needPin = false } = {}) {
  const r = await qr.resolve(token);
  if (r.kind === 'ROOM') {
    if (needStay && !r.stay) throw ApiError.conflict('This room is not checked in yet. Please see reception.', 'ROOM_NOT_OCCUPIED');
    if (needPin && r.stay && r.ctx.acc.selfService.guestPinRequired) {
      const ok = await stays.verifyPin(r.stay._id, pin);
      if (!ok) throw ApiError.forbidden('That code is not right. It is printed on your registration card.', 'PIN_INVALID');
    }
  }
  return r;
}

const label = (r) => (r.kind === 'TABLE' ? `Table ${r.doc.name}` : `Room ${r.doc.number}`);

async function context(token) {
  const r = await qr.resolve(token);
  const { ctx, doc } = r; const go = ctx.settings.guestOrdering || {};
  const branch = await Branch.findById(doc.branchId).select('name phone');
  let openOrder = null;
  if (r.kind === 'TABLE') openOrder = await RestaurantOrder.findOne({ businessId: doc.businessId, tableId: doc._id, status: 'OPEN', orderType: 'DINE_IN' }).select('orderNumber');
  const lang = ctx.business.language || 'en';
  const canOrder = ORDERING.includes(r.mode) && (r.kind === 'TABLE' ? (!!openOrder || go.selfSeat) : !!r.stay);
  let reason; if (!canOrder) reason = r.mode === 'OFF' ? 'OFF' : !ORDERING.includes(r.mode) ? 'MENU_ONLY' : r.kind === 'TABLE' ? 'TABLE_NOT_OPEN' : 'ROOM_NOT_OCCUPIED';
  return {
    googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
    business: { name: ctx.business.name, logo: ctx.business.logo, phone: branch?.phone || ctx.business.phone, currency: ctx.business.currency, language: lang, timezone: ctx.timeZone },
    branch: branch?.name,
    place: { kind: r.kind, label: label(r), seats: r.kind === 'TABLE' ? doc.seats : undefined, floor: r.kind === 'ROOM' ? doc.floor : undefined },
    mode: r.mode, canOrder, reason, orderingOpen: canOrder,
    needsPin: r.kind === 'ROOM' && !!r.stay && !!ctx.acc.selfService.guestPinRequired, pinLength: ctx.acc.selfService.guestPinLength || 4,
    hasStay: r.kind === 'ROOM' ? !!r.stay : undefined,
    guest: r.stay ? { firstName: String(r.stay.guest.name).split(' ')[0], checkOutDate: r.stay.checkOutDate } : undefined,
    options: { showPrices: go.showPrices !== false, allowNotes: go.allowNotes !== false, requireName: !!go.requireName, requirePhone: !!go.requirePhone, allowBillRequest: go.allowBillRequest !== false, maxItemsPerRequest: go.maxItemsPerRequest, maxQuantityPerItem: go.maxQuantityPerItem },
    welcome: lang === 'sw' ? (go.welcomeMessageSw || go.welcomeMessage) : (go.welcomeMessage || undefined),
    room: r.kind === 'ROOM' ? { selfCheckIn: !!ctx.acc.selfService.selfCheckIn, selfCheckOut: !!ctx.acc.selfService.selfCheckOut, roomService: ctx.acc.roomService.enabled, roomServiceHours: ctx.acc.roomService.hoursStart ? `${ctx.acc.roomService.hoursStart}-${ctx.acc.roomService.hoursEnd}` : undefined } : undefined,
  };
}

/** The menu a guest sees: public fields only (no costs, stock or stations), priced for their service type. */
async function menu(token) { const r = await qr.resolve(token); return menuFor({ businessId: r.doc.businessId, branchId: r.doc.branchId, ctx: r.ctx, orderType: r.kind === 'ROOM' ? 'ROOM_SERVICE' : 'DINE_IN' }); }
async function menuFor({ businessId, branchId, ctx, orderType }) {
  const r = { doc: { businessId, branchId }, ctx };
  const actor = await C.guestActor(businessId);
  const m = await menuSvc.getMenu(r.doc.businessId, actor, { branchId: r.doc.branchId, orderType });
  const show = r.ctx.settings.guestOrdering?.showPrices !== false;
  const clean = (i) => ({
    id: i._id, name: i.name, description: i.description, image: i.image, price: show ? i.effectivePrice : null, promoLabel: i.promoLabel, available: i.available, unavailableReason: i.unavailableReason,
    allergens: i.allergens, requireVariant: i.requireVariant, isCombo: i.isCombo,
    variants: (i.variants || []).filter((v) => v.active !== false).map((v) => ({ id: v._id, name: v.name, price: show ? (v.price ?? null) : null, priceDelta: show ? (v.priceDelta ?? 0) : null })),
    modifierGroups: (i.modifierGroups || []).map((g) => ({ id: g._id, name: g.name, required: g.required, min: g.min, max: g.max, allowQuantity: g.allowQuantity, options: (g.options || []).filter((o) => o.active !== false && !o.soldOut).map((o) => ({ id: o._id, name: o.name, priceDelta: show ? money(o.priceDelta) : null, allergens: o.allergens })) })),
    comboGroups: i.isCombo ? (i.comboGroups || []).map((g) => ({ name: g.name, min: g.min, max: g.max, options: g.options.map((o) => ({ menuItemId: o.menuItemId, priceDelta: show ? o.priceDelta : null })) })) : undefined,
  });
  return { currency: r.ctx.business.currency, generatedAt: m.generatedAt, categories: m.categories.map((c) => ({ id: c._id, name: c.name, items: c.items.map(clean) })) };
}

// ------------------------------------------------------------------ ordering
async function submit(token, body, { ip, pin, accountId } = {}) {
  const r = await place(token, { pin: body.pin ?? pin, needStay: true, needPin: true });
  const { ctx, doc } = r; const go = ctx.settings.guestOrdering || {}; const businessId = doc.businessId;
  if (!ORDERING.includes(r.mode)) throw ApiError.forbidden('Ordering from your phone is not switched on here. Please call a waiter.', 'ORDERING_DISABLED');
  if (body.clientRef) { const dup = await GuestRequest.findOne({ businessId, clientRef: body.clientRef }); if (dup) return view(dup, true); }
  if (!body.items?.length) throw ApiError.badRequest('Add something to your order', 'EMPTY_ORDER');
  if (body.items.length > (go.maxItemsPerRequest || 30)) throw ApiError.badRequest(`Please order at most ${go.maxItemsPerRequest} items at a time`, 'TOO_MANY_ITEMS');
  if (body.items.some((i) => i.quantity > (go.maxQuantityPerItem || 20))) throw ApiError.badRequest(`Please ask a waiter for more than ${go.maxQuantityPerItem} of one item`, 'QUANTITY_TOO_HIGH');
  if (go.requireName && !body.guest?.name) throw ApiError.badRequest('Please tell us your name', 'NAME_REQUIRED');
  if (go.requirePhone && !body.guest?.phone) throw ApiError.badRequest('Please enter your phone number', 'PHONE_REQUIRED');
  const ipHash = hashIp(ip);
  const placeFilter = r.kind === 'TABLE' ? { tableId: doc._id } : { roomId: doc._id };
  const recent = await GuestRequest.countDocuments({ businessId, ...placeFilter, createdAt: { $gt: new Date(Date.now() - 10 * 60000) } });
  if (recent >= 10) throw ApiError.conflict('You have sent several orders just now. Please wait a few minutes or call a waiter.', 'RATE_LIMITED');
  let openOrder = null;
  if (r.kind === 'TABLE') {
    openOrder = await RestaurantOrder.findOne({ businessId, tableId: doc._id, status: 'OPEN', orderType: 'DINE_IN' });
    if (!openOrder && !go.selfSeat) throw ApiError.conflict('Please ask a waiter to seat you first, or tap Call waiter.', 'TABLE_NOT_OPEN');
    if (!openOrder && doc.status === 'RESERVED') throw ApiError.conflict('This table is reserved. Please see a waiter.', 'TABLE_RESERVED');
  }
  // validate every line against the live menu and price it, so the guest sees problems now and not after the waiter reads it
  const tz = ctx.timeZone; const orderType = r.kind === 'ROOM' ? 'ROOM_SERVICE' : 'DINE_IN'; let estimate = 0; const lines = [];
  for (const it of body.items) {
    const menuItem = await MenuItem.findOne({ _id: it.menuItemId, businessId, status: 'active' });
    if (!menuItem) throw ApiError.badRequest('An item on your order is no longer on the menu', 'MENU_ITEM_NOT_FOUND');
    const av = P.availability(menuItem, { branchId: doc.branchId, timeZone: tz }); if (!av.ok) throw ApiError.badRequest(`${menuItem.name} is not available right now`, av.reason);
    const groups = await ModifierGroup.find({ businessId, _id: { $in: menuItem.modifierGroupIds } });
    let priced; try { priced = P.priceItem(menuItem, groups, { orderType, branchId: doc.branchId, variantId: it.variantId, modifiers: it.modifiers || [], timeZone: tz }); } catch (e) { throw ApiError.badRequest(e.message, e.code || 'INVALID_ITEM'); }
    if (priced.substitutionApproval) throw ApiError.badRequest(`${menuItem.name}: that change needs a waiter. Please call one.`, 'NEEDS_WAITER');
    estimate += Math.round(priced.unitPrice * it.quantity);
    lines.push({ menuItemId: menuItem._id, name: menuItem.name, quantity: it.quantity, variantId: it.variantId, modifiers: it.modifiers, comboPicks: it.comboPicks, notes: go.allowNotes === false ? undefined : it.notes, allergyNotes: go.allowNotes === false ? undefined : it.allergyNotes, unitPriceEstimate: priced.unitPrice });
  }
  let stay = r.stay;
  if (r.kind === 'ROOM') {
    const min = ctx.acc.roomService.minOrderCents || 0;
    if (min && estimate < min) throw ApiError.badRequest(`Room service orders start at ${(min / 100).toFixed(2)}`, 'BELOW_MINIMUM');
    await stays.resolveRoomForOrder(businessId, doc.branchId, { roomId: doc._id }, null);   // service hours, branch, checked-in guest
  }
  const auto = r.mode === 'ORDER_AUTO' && (!go.maxAutoOrderCents || estimate <= go.maxAutoOrderCents) && (r.kind === 'ROOM' || !!openOrder || go.selfSeat);
  let req;
  try {
    req = await GuestRequest.create({
      businessId, branchId: doc.branchId, kind: r.kind, tableId: r.kind === 'TABLE' ? doc._id : undefined, tableName: r.kind === 'TABLE' ? doc.name : undefined, roomId: r.kind === 'ROOM' ? doc._id : undefined, roomNumber: r.kind === 'ROOM' ? doc.number : undefined, stayId: stay?._id,
      items: lines, guest: { name: body.guest?.name || stay?.guest?.name, phone: body.guest?.phone }, notes: go.allowNotes === false ? undefined : body.notes, estimatedTotal: estimate, accountId, mode: auto ? 'AUTO' : 'CONFIRM', clientRef: body.clientRef, ipHash,
      expiresAt: new Date(Date.now() + (go.requestExpiryMinutes || 20) * 60000),
    });
  } catch (e) { if (e.code === 11000 && body.clientRef) return view(await GuestRequest.findOne({ businessId, clientRef: body.clientRef }), true); throw e; }
  if (auto) {
    try { const actor = await C.guestActor(businessId); req = await fulfil(req, actor, { send: true, auto: true }); }
    catch (e) { req.status = 'FAILED'; req.failure = e.message; await req.save(); throw e; }
  } else notifyRequest(req);
  return view(req);
}

function notifyRequest(req) {
  const text = `${req.kind === 'TABLE' ? `Table ${req.tableName}` : `Room ${req.roomNumber}`}: ${req.items.length} item(s) waiting for you to accept.`;
  const payload = { type: 'GUEST_ORDER_REQUEST', title: 'New order from a guest', message: text, branchId: req.branchId, entityType: 'GuestRequest', entityId: req._id };
  require('../restaurant/common').notifyRoles(req.businessId, req.branchId, [...C.FLOOR_LEAD_ROLES, 'WAITER', 'BARTENDER', 'CASHIER', 'RECEPTIONIST'], payload);
}

/**
 * Turns a guest request into a real order: adds to the table's open order (or opens one), sends to the kitchen.
 * `user` is the waiter who accepted it, or the guest actor for automatic acceptance.
 */
async function fulfil(req, user, { send = true, auto = false, dropIndexes = [] } = {}) {
  const businessId = req.businessId; const fresh = await GuestRequest.findOneAndUpdate({ _id: req._id, status: { $in: ['PENDING', 'FAILED'] }, ...(auto ? {} : {}) }, { $set: { status: 'PENDING' } }, { new: true });
  if (!fresh && req.status !== 'PENDING') throw ApiError.conflict(`This order was already ${req.status.toLowerCase()}`, 'REQUEST_NOT_PENDING');
  const items = req.items.filter((_, i) => !dropIndexes.includes(i));
  if (!items.length) throw ApiError.badRequest('Nothing left to send', 'EMPTY_ORDER');
  let order;
  if (req.kind === 'TABLE') {
    order = await RestaurantOrder.findOne({ businessId, tableId: req.tableId, status: 'OPEN', orderType: 'DINE_IN' });
    if (!order) {
      ({ order } = await orders.createOrder(businessId, user, { branchId: req.branchId, orderType: 'DINE_IN', tableId: req.tableId, source: 'QR_TABLE', guestCount: 1, customerName: req.guest?.name, customerPhone: req.guest?.phone, clientRef: `qr-${req._id}`, deviceId: 'qr', _guest: !!user.isGuestActor }));
    }
  } else {
    order = (await orders.createOrder(businessId, user, { branchId: req.branchId, orderType: 'ROOM_SERVICE', roomId: req.roomId, stayId: req.stayId, source: 'QR_ROOM', guestCount: 1, customerName: req.guest?.name, customerPhone: req.guest?.phone, clientRef: `qr-${req._id}`, deviceId: 'qr', _guest: !!user.isGuestActor })).order;
  }
  const raw = items.map((i, k) => ({ menuItemId: i.menuItemId, quantity: i.quantity, variantId: i.variantId, modifiers: (i.modifiers || []).map((m) => ({ groupId: m.groupId, optionId: m.optionId, quantity: m.quantity })), comboPicks: i.comboPicks && i.comboPicks.length ? i.comboPicks : undefined, notes: i.notes, allergyNotes: i.allergyNotes, clientItemId: `gr-${req._id}-${k}` }));
  const res = await orders.addItems(businessId, user, order._id, { items: raw, sendNow: send });
  await RestaurantOrder.updateOne({ _id: order._id }, { $addToSet: { guestRequestIds: req._id } });
  const done = await GuestRequest.findOneAndUpdate({ _id: req._id }, { $set: { status: auto ? 'AUTO_ACCEPTED' : 'ACCEPTED', orderId: order._id, 'decision.at': new Date(), 'decision.by': auto ? undefined : user._id, 'decision.byName': auto ? 'Automatic' : user.name } }, { new: true });
  const wid = res.order.waiterId;
  const text = { type: 'GUEST_ORDER_PLACED', title: `${req.kind === 'TABLE' ? `Table ${req.tableName}` : `Room ${req.roomNumber}`}: guest order sent`, message: `${items.length} item(s) went to the kitchen.`, branchId: req.branchId, entityType: 'RestaurantOrder', entityId: order._id };
  if (auto) { if (wid) C.notifyUser(businessId, wid, text); else C.notifyRoles(businessId, req.branchId, [...C.FLOOR_LEAD_ROLES, 'WAITER', 'RECEPTIONIST'], text); }
  return done;
}

/** One word for where an order is: RECEIVED > CONFIRMED > PREPARING > READY > SERVED (the guest sees this as a progress bar). */
function stageOf(o) {
  const live = o.items.filter((i) => !['CANCELLED', 'DRAFT', 'HELD'].includes(i.status) && !i.parentItemId); if (!live.length) return 'RECEIVED';
  if (live.every((i) => i.status === 'SERVED')) return 'SERVED';
  if (live.every((i) => ['READY', 'SERVED'].includes(i.status))) return 'READY';
  if (live.some((i) => ['PREPARING', 'READY', 'SERVED'].includes(i.status))) return 'PREPARING';
  if (live.some((i) => i.status === 'ACCEPTED')) return 'CONFIRMED';
  return 'RECEIVED';
}

const view = (req, replayed = false) => ({ id: req._id, status: req.status, mode: req.mode, replayed, orderId: req.orderId, estimatedTotal: money(req.estimatedTotal), items: req.items.length, message: ({ PENDING: 'A waiter will confirm your order shortly.', ACCEPTED: 'Your order was accepted.', AUTO_ACCEPTED: 'Your order was sent to the kitchen.', REJECTED: req.decision?.reason || 'Your order could not be accepted.', EXPIRED: 'Your order expired. Please try again or call a waiter.', FAILED: req.failure || 'Your order could not be sent.' })[req.status], createdAt: req.createdAt });

// ------------------------------------------------------------------ status
async function status(token, { pin } = {}) {
  const r = await place(token, { pin, needPin: true });
  const { doc, ctx } = r; const businessId = doc.businessId; const show = ctx.settings.guestOrdering?.showPrices !== false;
  const placeFilter = r.kind === 'TABLE' ? { tableId: doc._id } : { roomId: doc._id };
  const since = new Date(Date.now() - 4 * 3600000);
  const [reqs, os, openCalls] = await Promise.all([
    GuestRequest.find({ businessId, ...placeFilter, createdAt: { $gt: since } }).sort({ createdAt: -1 }).limit(10),
    RestaurantOrder.find(r.kind === 'TABLE' ? { businessId, tableId: doc._id, status: 'OPEN', orderType: 'DINE_IN' } : { businessId, stayId: r.stay?._id, orderType: 'ROOM_SERVICE', createdAt: { $gt: since } }).sort({ createdAt: -1 }).limit(10),
    require('../../models/ServiceCall').find({ businessId, ...placeFilter, status: { $in: ['OPEN', 'ACKNOWLEDGED'] } }),
  ]);
  return {
    place: label(r),
    requests: reqs.map((q) => view(q)),
    orders: os.map((o) => ({ id: o._id, orderNumber: o.orderNumber, stage: stageOf(o), placedAt: o.createdAt, status: o.status, billStatus: o.billStatus, total: show ? money(o.totals.total) : null, items: o.items.filter((i) => i.status !== 'CANCELLED' && !i.parentItemId).map((i) => ({ name: i.name, quantity: i.quantity, status: i.status === 'PENDING' || i.status === 'ACCEPTED' ? 'RECEIVED' : i.status, notes: i.notes })) })),
    calls: openCalls.map((c) => ({ id: c._id, kind: c.kind, status: c.status, at: c.createdAt })),
  };
}

// ------------------------------------------------------------------ calls and bill
async function call(token, { kind, note, pin, guestName }) {
  const r = await place(token, { pin, needStay: false, needPin: true });
  const allowed = r.kind === 'TABLE' ? TABLE_CALLS : ROOM_CALLS;
  if (!allowed.includes(kind)) throw ApiError.badRequest('That request is not available here', 'INVALID_CALL');
  if (r.kind === 'ROOM' && !r.stay) throw ApiError.conflict('This room is not checked in yet. Please see reception.', 'ROOM_NOT_OCCUPIED');
  if (kind === 'BILL' && r.ctx.settings.guestOrdering?.allowBillRequest === false) throw ApiError.badRequest('Please ask a waiter for the bill', 'BILL_REQUEST_DISABLED');
  const { doc, ctx } = r; let order = null;
  if (r.kind === 'TABLE') order = await RestaurantOrder.findOne({ businessId: doc.businessId, tableId: doc._id, status: 'OPEN', orderType: 'DINE_IN' });
  if (kind === 'BILL' && order) { try { const actor = await C.guestActor(doc.businessId); await orders.requestBill(doc.businessId, actor, order._id); } catch (e) { if (e.code !== 'NOTHING_TO_BILL') throw e; throw ApiError.badRequest('Nothing has been ordered yet', 'NOTHING_TO_BILL'); } }
  if (kind === 'BILL' && !order) throw ApiError.badRequest('Nothing has been ordered yet', 'NOTHING_TO_BILL');
  const res = await calls.raise({ ctx, businessId: doc.businessId, branchId: doc.branchId, kind, table: r.kind === 'TABLE' ? doc : null, room: r.kind === 'ROOM' ? doc : null, stay: r.stay, order, note: String(note || '').slice(0, 300) || undefined, guestName });
  return { id: res.call._id, kind: res.call.kind, status: res.call.status, merged: res.merged, message: res.merged ? 'We already told the team. Someone is on the way.' : 'The team has been told. Someone is on the way.' };
}

// ------------------------------------------------------------------ rooms: folio, check-in, check-out
async function folioView(token, { pin }) {
  const r = await place(token, { pin, needStay: true, needPin: true });
  const s = await Stay.findById(r.stay._id); folio.recompute(s);
  return { stayNumber: s.stayNumber, guest: s.guest.name, room: s.roomNumber, checkInDate: s.checkInDate, checkOutDate: s.checkOutDate, checkOutTime: s.policy.checkOutTime,
    lines: s.folio.filter((l) => !l.voided).map((l) => ({ description: l.description, quantity: l.quantity, total: money(l.total), date: l.postedAt })), charges: money(s.totals.charges), paid: money(s.totals.paid), balance: money(s.totals.balance), currency: r.ctx.business.currency };
}

async function requestCheckout(token, { pin, note }) {
  const r = await place(token, { pin, needStay: true, needPin: true });
  if (!r.ctx.acc.selfService.selfCheckOut) throw ApiError.badRequest('Please check out at reception', 'SELF_CHECKOUT_DISABLED');
  await Stay.updateOne({ _id: r.stay._id }, { $set: { checkoutRequestedAt: new Date() } });
  const res = await calls.raise({ ctx: r.ctx, businessId: r.doc.businessId, branchId: r.doc.branchId, kind: 'CHECKOUT', room: r.doc, stay: r.stay, note });
  return { merged: res.merged, message: 'Reception has been told you are ready to check out.' };
}

/** Guest checks themselves out from the room. Only when nothing is owing: otherwise reception finishes it. */
async function selfCheckOut(token, { pin }) {
  const r = await place(token, { pin, needStay: true, needPin: true });
  if (!r.ctx.acc.selfService.selfCheckOut) throw ApiError.badRequest('Please check out at reception', 'SELF_CHECKOUT_DISABLED');
  const s = await Stay.findById(r.stay._id); folio.recompute(s);
  const dep = stays.computeDeparture(r.ctx, s, new Date());
  const extra = dep.adds.reduce((a, x) => a + x.unitPrice, 0);
  if (s.totals.balance > 0 || extra > 0) { await requestCheckout(token, { pin, note: 'Guest wants to check out' }); throw ApiError.conflict('There is a balance to settle, so reception will finish your check-out. They have been told.', 'BALANCE_OWING'); }
  const actor = await C.guestActor(r.doc.businessId);
  const out = await stays.checkOut(r.doc.businessId, actor, s._id, { payments: [], selfService: true });
  return { checkedOut: true, receiptNumber: out.stay.receiptNumber, message: 'Thank you for staying with us. You are checked out.' };
}

/** Arrival confirmation from the room's QR code: needs the booking code and the last four digits of the phone on the booking. */
async function selfCheckIn(token, { bookingCode, phoneLast4 }, { ip } = {}) {
  const r = await qr.resolve(token);
  if (r.kind !== 'ROOM') throw ApiError.badRequest('Not a room code', 'NOT_A_ROOM');
  const ctx = r.ctx; if (!ctx.acc.selfService.selfCheckIn) throw ApiError.badRequest('Please check in at reception', 'SELF_CHECKIN_DISABLED');
  const stay = await Stay.findOne({ businessId: r.doc.businessId, roomId: r.doc._id, bookingCode: String(bookingCode || '').toUpperCase(), status: 'RESERVED' });
  const digits = String(stay?.guest?.phone || '').replace(/\D/g, '');
  if (!stay || !phoneLast4 || digits.slice(-4) !== String(phoneLast4)) throw ApiError.forbidden('We could not match that booking to this room. Please see reception.', 'BOOKING_NOT_FOUND');
  const T0 = new Date(stay.expectedCheckIn.getTime() - ctx.acc.selfService.selfCheckInOpensHoursBefore * 3600000);
  if (new Date() < T0) throw ApiError.conflict('It is too early to check in yourself. Please see reception.', 'TOO_EARLY');
  if (ctx.acc.selfService.requireDepositPaidForSelfCheckIn && stay.depositRequired > 0 && !stay.payments.some((p) => p.kind === 'DEPOSIT')) throw ApiError.conflict('Your deposit has not been received. Please see reception.', 'DEPOSIT_REQUIRED');
  if (ctx.acc.stay.requireIdAtCheckIn && !(stay.guest.idType && stay.guest.idNumber)) throw ApiError.conflict('Reception needs to see your ID first.', 'ID_REQUIRED');
  const actor = await C.guestActor(r.doc.businessId);
  const out = await stays.checkIn(r.doc.businessId, actor, stay._id, { selfService: true });
  await Stay.updateOne({ _id: stay._id }, { $set: { 'selfCheckIn.at': new Date() } });
  return { checkedIn: true, pin: out.pin, room: r.doc.number, message: 'Welcome! You are checked in.' };
}

// ------------------------------------------------------------------ staff side
async function listRequests(businessId, user, { branchId, status }) {
  C.requireCan(user, 'restaurant.guest.view', 'Needs permission');
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  f.status = status ? { $in: String(status).split(',') } : 'PENDING';
  return GuestRequest.find(f).sort({ createdAt: 1 }).limit(200);
}

async function accept(businessId, user, id, { dropIndexes = [], sendNow = true } = {}) {
  C.requireCan(user, 'restaurant.guest.respond', 'Needs permission');
  C.requireCan(user, 'restaurant.orders.create', 'Needs permission to take orders');
  const req = await GuestRequest.findOne({ _id: id, businessId }); if (!req) throw ApiError.notFound('Order not found', 'REQUEST_NOT_FOUND'); C.assertBranchAccess(user, req.branchId);
  if (req.status !== 'PENDING') throw ApiError.conflict(`This order was already ${req.status.toLowerCase()}`, 'REQUEST_NOT_PENDING');
  const done = await fulfil(req, user, { send: sendNow, dropIndexes });
  const o = await RestaurantOrder.findById(done.orderId);
  if (o && !o.waiterId && ['WAITER', 'HEAD_WAITER', 'BARTENDER', 'SUPERVISOR'].includes(user.role) && o.status === 'OPEN') await orders.claimOrder(businessId, user, o._id).catch(() => {});
  return done;
}
async function reject(businessId, user, id, { reason }) {
  C.requireCan(user, 'restaurant.guest.respond', 'Needs permission');
  const req = await GuestRequest.findOne({ _id: id, businessId }); if (!req) throw ApiError.notFound('Order not found', 'REQUEST_NOT_FOUND'); C.assertBranchAccess(user, req.branchId);
  if (req.status !== 'PENDING') throw ApiError.conflict(`This order was already ${req.status.toLowerCase()}`, 'REQUEST_NOT_PENDING');
  req.status = 'REJECTED'; req.decision = { by: user._id, byName: user.name, at: new Date(), reason: reason || 'Sorry, we could not take that order.' }; await req.save(); return req;
}
/** Withdraws guest orders nobody accepted in time. Called by the job. */
async function expireStale() {
  const r = await GuestRequest.updateMany({ status: 'PENDING', expiresAt: { $lt: new Date() } }, { $set: { status: 'EXPIRED' } });
  return r.modifiedCount || 0;
}

module.exports = { menuFor, stageOf, context, menu, submit, status, call, folioView, requestCheckout, selfCheckOut, selfCheckIn, listRequests, accept, reject, expireStale, fulfil, place, label, money };
