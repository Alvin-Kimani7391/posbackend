/**
 * The restaurant order: the central record joining waiter, kitchen, cashier, inventory and customer.
 * An open order is NEVER a sale. Money is settled by bill.service, which creates the Sale only when a bill is paid.
 */
const mongoose = require('mongoose');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantTable = require('../../models/RestaurantTable');
const RestaurantBill = require('../../models/RestaurantBill');
const KitchenTicket = require('../../models/KitchenTicket');
const MenuItem = require('../../models/MenuItem');
const ModifierGroup = require('../../models/ModifierGroup');
const Recipe = require('../../models/Recipe');
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const Customer = require('../../models/Customer');
const Reservation = require('../../models/Reservation');
const User = require('../../models/User');
const ServiceIncident = require('../../models/ServiceIncident');
const ApiError = require('../../utils/ApiError');
const { nextSequence, pad } = require('../../models/Counter');
const { localParts } = require('../../utils/restaurantTime');
const P = require('../../utils/restaurantPricing');
const { ROLES } = require('../../constants/roles');
const { NOT_STARTED_STATUS } = require('../../constants/restaurant');
const { ensureSystemProduct, DELIVERY_FEE_SKU } = require('./systemProducts');
const tables = require('./table.service');
const kitchen = require('./kitchen.service');
const consumption = require('./consumption.service');
const bills = require('./bill.service');
const prints = require('./print.service');
const C = require('./common');

const oidNew = () => new mongoose.Types.ObjectId();
const pe = (e) => (e.code && !(e instanceof ApiError) && /^[A-Z_]+$/.test(e.code) ? ApiError.badRequest(e.message, e.code) : e);
const FLOOR_ROLES = [ROLES.WAITER, ROLES.HEAD_WAITER, ROLES.BARTENDER, ROLES.SUPERVISOR];

// ------------------------------------------------------------------ create
async function createOrder(businessId, user, input) {
  C.assertBranchAccess(user, input.branchId);
  if (input.clientRef && input.deviceId) {
    const dup = await RestaurantOrder.findOne({ businessId, branchId: input.branchId, deviceId: input.deviceId, clientRef: input.clientRef });
    if (dup) return { order: dup, replayed: true };
  }
  try {
    const order = await C.inTx(async (session) => {
      const ctx = await C.getContext(businessId, session);
      if (!ctx.features.ordering) throw ApiError.forbidden('The restaurant module is not enabled', 'FEATURE_DISABLED');
      const branch = await C.assertBranch(businessId, input.branchId, session);
      const type = input.orderType || (ctx.settings.serviceMode === 'ACCOMMODATION' ? 'ROOM_SERVICE' : 'DINE_IN');
      if (ctx.settings.serviceMode === 'ACCOMMODATION' && !['ROOM_SERVICE', 'COUNTER', 'TAKEAWAY'].includes(type)) throw ApiError.badRequest('This business only serves guests staying in its rooms', 'ORDER_TYPE_NOT_ALLOWED');
      if (ctx.settings.serviceMode === 'RESTAURANT' && type === 'ROOM_SERVICE') throw ApiError.badRequest('Room service is not enabled', 'ORDER_TYPE_NOT_ALLOWED');
      const _id = oidNew();
      let table = null;
      if (ctx.features.tables && type === 'DINE_IN') {
        if (!input.tableId) throw ApiError.badRequest('Choose a table', 'TABLE_REQUIRED');
        const t0 = await RestaurantTable.findOne({ _id: input.tableId, businessId }).session(session);
        if (!t0) throw ApiError.badRequest('Table not found', 'TABLE_NOT_FOUND');
        if (!C.sameId(t0.branchId, input.branchId)) throw ApiError.badRequest('Table belongs to another branch', 'BRANCH_MISMATCH');
        if (t0.waiterId && !C.sameId(t0.waiterId, user._id) && !C.can(user, 'restaurant.tables.view_all')) throw ApiError.forbidden(`Table ${t0.name} is assigned to another waiter`, 'TABLE_NOT_YOURS');
        let allowReserved = C.can(user, 'restaurant.tables.manage');
        if (input.reservationId) {
          const r = await Reservation.findOne({ _id: input.reservationId, businessId, branchId: input.branchId }).session(session);
          if (!r || !['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(r.status)) throw ApiError.badRequest('Reservation not found or not active', 'RESERVATION_NOT_ACTIVE');
          if (!r.tableIds.some((x) => C.sameId(x, t0._id))) throw ApiError.badRequest('That reservation is for a different table', 'RESERVATION_TABLE_MISMATCH');
          allowReserved = true;
        } else if (!allowReserved) {      // a walk-in cannot take a table that is held for a booking starting soon (the owner sets how soon)
          const hold = await require('./reservation.service').lockingReservation(businessId, t0._id, ctx.settings, session);
          if (hold) throw ApiError.conflict(`Table ${t0.name} is reserved for ${hold.guestName} (${hold.reservationNumber})`, 'TABLE_RESERVED');
        }
        table = await tables.claimTable({ businessId, tableId: input.tableId, orderId: _id, guestCount: input.guestCount, waiterId: undefined, allowReserved, allowCleaning: C.can(user, 'restaurant.tables.manage'), session });
      }
      if (type === 'DELIVERY' && (!input.delivery?.phone || !input.delivery?.address)) throw ApiError.badRequest('Delivery needs a phone number and address', 'DELIVERY_DETAILS_REQUIRED');
      if (['PICKUP', 'TAKEAWAY'].includes(type) && !input.customerName && !input.customerPhone && type === 'PICKUP') throw ApiError.badRequest('Pickup orders need a customer name or phone', 'CONTACT_REQUIRED');
      let customer = null;
      if (input.customerId) { customer = await Customer.findOne({ _id: input.customerId, businessId, status: 'active' }).session(session); if (!customer) throw ApiError.badRequest('Customer not found', 'INVALID_CUSTOMER'); }
      let room = null; let stay = null;
      if (type === 'ROOM_SERVICE') {                                  // a guest's order from their room: the room must be occupied by a checked-in stay
        const hospitality = require('../hospitality/stay.service');
        ({ room, stay } = await hospitality.resolveRoomForOrder(businessId, input.branchId, { roomId: input.roomId, stayId: input.stayId }, session));
      }
      let waiterId = user._id; let waiterName = user.name;
      if (input._guest) { waiterId = table?.waiterId || undefined; waiterName = undefined; if (waiterId) { const w = await User.findById(waiterId).select('name').session(session); waiterName = w?.name; } }
      else if (input.waiterId && !C.sameId(input.waiterId, user._id)) {
        C.requireCan(user, 'restaurant.tables.assign', 'Only a supervisor can open an order for another waiter');
        const w = await User.findOne({ _id: input.waiterId, businessId, status: 'active' }).session(session); if (!w) throw ApiError.badRequest('Waiter not found', 'USER_NOT_FOUND');
        waiterId = w._id; waiterName = w.name;
      } else if (table?.waiterId && !FLOOR_ROLES.includes(user.role)) { const w = await User.findById(table.waiterId).select('name').session(session); waiterId = table.waiterId; waiterName = w?.name; }
      else if (!FLOOR_ROLES.includes(user.role) && !table?.waiterId) { waiterId = user._id; }
      if (table && waiterId && (!table.waiterId || !C.sameId(table.waiterId, waiterId))) await RestaurantTable.updateOne({ _id: table._id }, { $set: { waiterId } }, { session });
      const seq = await nextSequence(businessId, `restorder:branch:${input.branchId}`, session);
      let pickupNumber;
      if (['PICKUP', 'TAKEAWAY', 'COUNTER'].includes(type)) { const ymd = localParts(new Date(), ctx.timeZone).ymd; pickupNumber = `P${pad(await nextSequence(businessId, `pickup:${input.branchId}:${ymd}`, session), 3)}`; }
      const doc = {
        _id, businessId, branchId: input.branchId, orderNumber: `ORD-${branch.code || 'MAIN'}-${pad(seq, 5)}`, pickupNumber, orderType: type, source: input.source || 'WAITER',
        tableId: table?._id, tableName: table?.name, waiterId, waiterName, openedBy: user._id, guestCount: input.guestCount ?? 1, customerId: customer?._id,
        customerName: customer?.name || input.customerName, customerPhone: customer?.phone || input.customerPhone, reservationId: input.reservationId, roomId: room?._id, roomNumber: room?.number, stayId: stay?._id, notes: input.notes, priority: input.priority || 'NORMAL',
        clientRef: input.clientRef, deviceId: input.deviceId, history: [{ at: new Date(), action: 'order.open', by: user._id }], items: [],
      };
      if (type === 'ROOM_SERVICE' && !input.customerName) doc.customerName = stay.guest.name;
      if (type === 'DELIVERY') doc.delivery = { ...input.delivery, status: 'PENDING' };
      if (['PICKUP', 'TAKEAWAY'].includes(type)) doc.pickup = { status: 'WAITING' };
      const [o] = await RestaurantOrder.create([doc], { session });
      if (type === 'DELIVERY' && input.delivery.fee > 0) {
        const p = await ensureSystemProduct(businessId, DELIVERY_FEE_SKU, 'Delivery fee', 0, session);
        o.items.push({ productId: p._id, sku: DELIVERY_FEE_SKU, name: 'Delivery fee', quantity: 1, unitPrice: input.delivery.fee, taxRate: 0, serviceChargeable: false, status: 'SERVED', servedAt: new Date(), addedBy: user._id, stockMode: 'NONE' });
      }
      C.recalcOrder(o, ctx); await o.save({ session });
      if (input.reservationId) await Reservation.updateOne({ _id: input.reservationId, businessId }, { $set: { status: 'SEATED', seatedAt: new Date(), orderId: o._id } }, { session });
      await C.audit({ businessId, branchId: o.branchId, userId: user._id, action: 'restaurant.order.create', entityType: 'RestaurantOrder', entityId: o._id, newValue: { orderNumber: o.orderNumber, type, table: o.tableName } }, session);
      return o;
    });
    if (!C.sameId(order.waiterId, user._id)) C.notifyUser(businessId, order.waiterId, { type: 'TABLE_ASSIGNED', title: `New order: ${order.tableName || order.orderNumber}`, message: `${user.name} opened ${order.tableName || order.orderNumber} for you.`, branchId: order.branchId, entityType: 'RestaurantOrder', entityId: order._id });
    return { order, replayed: false };
  } catch (err) {
    if (err.code === 11000 && input.clientRef && input.deviceId) { const dup = await RestaurantOrder.findOne({ businessId, branchId: input.branchId, deviceId: input.deviceId, clientRef: input.clientRef }); if (dup) return { order: dup, replayed: true }; }
    if (err.code === 11000 && err.keyPattern?.tableId) throw ApiError.conflict('Another waiter just opened this table', 'TABLE_OCCUPIED');
    throw pe(err);
  }
}

async function getOrder(businessId, user, id) {
  const order = await C.loadOrder(businessId, id); C.assertOrderAccess(user, order);
  const [billList, tickets] = await Promise.all([RestaurantBill.find({ businessId, orderId: order._id }).sort({ createdAt: 1 }), KitchenTicket.find({ businessId, orderId: order._id }).select('ticketNumber stationName type status priority receivedAt readyAt').sort({ receivedAt: 1 })]);
  return { order, bills: billList, tickets };
}

async function listOrders(businessId, user, q) {
  const { branchId, status, orderType, tableId, waiterId, billStatus, search, from, to, mine, page = 1, limit = 20 } = q;
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (q.source) f.source = q.source; if (status) f.status = status; if (orderType) f.orderType = orderType; if (tableId) f.tableId = tableId; if (billStatus) f.billStatus = billStatus;
  if (from || to) { f.createdAt = {}; if (from) f.createdAt.$gte = new Date(from); if (to) f.createdAt.$lte = new Date(to); }
  if (!C.can(user, 'restaurant.orders.view_all') || mine) f.$or = [{ waiterId: user._id }, { openedBy: user._id }, ...(mine ? [] : [{ waiterId: { $exists: false } }])]; else if (waiterId) f.waiterId = waiterId;
  if (search) { const rx = new RegExp(C.escapeRegex(search), 'i'); f.$and = [{ $or: [{ orderNumber: rx }, { tableName: rx }, { customerName: rx }, { customerPhone: rx }, { pickupNumber: rx }] }]; }
  const [items, total] = await Promise.all([RestaurantOrder.find(f).select('-history').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), RestaurantOrder.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}

// ------------------------------------------------------------------ items
async function buildItem(businessId, ctx, order, raw, user, cache) {
  const menu = cache.items.get(String(raw.menuItemId)) || await MenuItem.findOne({ _id: raw.menuItemId, businessId }).session(cache.session);
  if (!menu) throw ApiError.badRequest('Menu item not found', 'MENU_ITEM_NOT_FOUND');
  cache.items.set(String(menu._id), menu);
  const groups = await ModifierGroup.find({ businessId, _id: { $in: menu.modifierGroupIds } }).session(cache.session);
  let priced;
  try { priced = P.priceItem(menu, groups, { orderType: order.orderType, branchId: order.branchId, variantId: raw.variantId, modifiers: raw.modifiers || [], timeZone: ctx.timeZone }); } catch (e) { throw pe(e); }
  if (priced.substitutionApproval) C.requireCan(user, 'restaurant.orders.substitute', 'A substitution that changes cost or allergens needs supervisor approval');
  let combo = [];
  if (menu.isCombo) { try { combo = P.resolveCombo(menu, raw.comboPicks || []); } catch (e) { throw pe(e); } }
  const station = await C.stationFor(businessId, order.branchId, menu.stationCode, cache.session, cache.stations);
  const cat = menu.categoryId ? (cache.cats.get(String(menu.categoryId)) || await Category.findById(menu.categoryId).select('name').session(cache.session)) : null;
  if (cat) cache.cats.set(String(cat._id), cat);
  let costUnit = menu.costCents + priced.modifiers.reduce((s, m) => s + m.costDelta * m.quantity, 0);
  let recipe = null;
  if (menu.stockMode === 'RECIPE') recipe = await Recipe.findOne({ businessId, menuItemId: menu._id, isCurrent: true }).session(cache.session);
  if (menu.stockMode === 'PRODUCT') { const p = await Product.findById(menu.productId).select('costPrice').session(cache.session); costUnit = p?.costPrice || 0; }
  const v = raw.variantId ? menu.variants.id(raw.variantId) : null;
  const comboDelta = combo.reduce((s, c) => s + c.priceDelta * c.quantity, 0);
  const allergens = [...new Set([...(menu.allergens || []), ...priced.modifiers.flatMap((m) => m.allergens || [])])];
  const id = oidNew();
  const parent = {
    _id: id, clientItemId: raw.clientItemId, menuItemId: menu._id, productId: menu.productId, sku: cache.skus.get(String(menu.productId)) || (await Product.findById(menu.productId).select('sku').session(cache.session)).sku, name: menu.name,
    variantId: v?._id, variantName: priced.variantName, portionMultiplier: v?.portionMultiplier || 1, categoryId: menu.categoryId, categoryName: cat?.name,
    quantity: raw.quantity, unitPrice: priced.unitPrice + comboDelta, basePrice: priced.basePrice, promoLabel: priced.promoLabel, taxRate: menu.taxRate, serviceChargeable: menu.serviceChargeable,
    costUnit: Math.round(costUnit), modifiers: priced.modifiers, notes: raw.notes, allergyNotes: raw.allergyNotes, allergens, course: raw.course || 1, seatNumber: raw.seatNumber,
    stationId: station?._id, stationCode: station?.code, stationName: station?.name, stationType: station?.type || 'KITCHEN', prepMinutes: menu.prepMinutes,
    status: 'DRAFT', stockMode: menu.isCombo ? 'NONE' : menu.stockMode, recipeId: recipe?._id, recipeVersion: recipe?.version, addedBy: user._id, addedAt: new Date(),
  };
  const out = [parent];
  for (const c of combo) {
    const cm = await MenuItem.findOne({ _id: c.menuItemId, businessId, status: 'active' }).session(cache.session);
    if (!cm) throw ApiError.badRequest('A combo component is no longer available', 'COMBO_COMPONENT_INVALID');
    const av = P.availability(cm, { branchId: order.branchId, timeZone: ctx.timeZone }); if (!av.ok) throw ApiError.badRequest(`${cm.name} is not available (${av.reason.toLowerCase().replace(/_/g, ' ')})`, av.reason);
    const cst = await C.stationFor(businessId, order.branchId, cm.stationCode, cache.session, cache.stations);
    const crec = cm.stockMode === 'RECIPE' ? await Recipe.findOne({ businessId, menuItemId: cm._id, isCurrent: true }).session(cache.session) : null;
    const prod = await Product.findById(cm.productId).select('sku costPrice').session(cache.session);
    const cv = c.variantId ? cm.variants.id(c.variantId) : null;
    out.push({ _id: oidNew(), menuItemId: cm._id, productId: cm.productId, sku: prod.sku, name: cm.name, variantId: cv?._id, variantName: cv?.name, portionMultiplier: cv?.portionMultiplier || 1, quantity: raw.quantity * c.quantity, unitPrice: 0, taxRate: 0, serviceChargeable: false,
      costUnit: cm.stockMode === 'PRODUCT' ? (prod.costPrice || 0) : cm.costCents, course: raw.course || 1, seatNumber: raw.seatNumber, stationId: cst?._id, stationCode: cst?.code, stationName: cst?.name, stationType: cst?.type || 'KITCHEN', prepMinutes: cm.prepMinutes,
      status: 'DRAFT', parentItemId: id, comboGroup: c.groupName, allergens: cm.allergens, stockMode: cm.stockMode, recipeId: crec?._id, recipeVersion: crec?.version, addedBy: user._id, addedAt: new Date() });
  }
  return out;
}

async function sendDrafts(order, ctx, user, session, { fireCourse } = {}) {
  const now = new Date();
  const changed = [];
  for (const i of order.items) {
    const parent = i.parentItemId ? order.items.id(i.parentItemId) : null;
    const course = parent ? parent.course : i.course;
    if (i.status === 'DRAFT') {
      if (fireCourse === undefined && course > 1) { i.status = 'HELD'; i.sentAt = now; continue; }
      if (fireCourse !== undefined) continue;
      i.status = 'PENDING'; i.sentAt = now; changed.push(i);
    } else if (fireCourse !== undefined && i.status === 'HELD' && course === fireCourse) { i.status = 'PENDING'; i.sentAt = i.sentAt || now; changed.push(i); }
  }
  if (!changed.length) return { tickets: [], changed };
  const type = fireCourse !== undefined ? 'FIRE' : (order.firstSentAt ? 'ADDITION' : 'NEW');
  let tickets = [];
  const readyNow = [];
  if (ctx.ops.screen) tickets = await kitchen.createTickets(order, changed, { type, ctx, session });
  else {
    // NO kitchen screen: AUTO (dine-in) = ready when sent; MANUAL (delivery/pickup/takeaway/counter) = PREPARING until front-of-house taps Mark ready.
    for (const i of changed) {
      i.acceptedAt = now; i.preparingAt = now;
      if (ctx.ops.readyFor(order.orderType) === 'MANUAL') i.status = 'PREPARING';
      else { i.status = 'READY'; i.readyAt = now; readyNow.push(i._id); }
    }
    await prints.enqueueOrderKot(order, changed, { type, ctx, session });
  }
  order.firstSentAt = order.firstSentAt || now;
  await consumption.depleteDue(order, 'ON_SEND', { ctx, userId: user._id, session, onlyIds: changed.map((i) => i._id) });
  if (readyNow.length) await consumption.depleteDue(order, 'ON_READY', { ctx, userId: user._id, session, onlyIds: readyNow });
  return { tickets, changed };
}

async function addItems(businessId, user, id, { items, expectedVersion, sendNow = false }) {
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, id, session);
    C.assertOrderAccess(user, order, { write: true }); C.assertOpen(order); C.checkVersion(order, expectedVersion);
    const cache = { session, items: new Map(), cats: new Map(), skus: new Map(), stations: await C.ensureStations(businessId, order.branchId, session) };
    let added = 0;
    for (const raw of items) {
      if (raw.clientItemId && order.items.some((x) => x.clientItemId === raw.clientItemId)) continue;   // offline replay
      for (const it of await buildItem(businessId, ctx, order, raw, user, cache)) order.items.push(it);
      added += 1;
    }
    let sent = { tickets: [], changed: [] };
    if (sendNow) sent = await sendDrafts(order, ctx, user, session);
    if (order.billStatus === 'PAID') order.billStatus = 'PARTIAL';
    C.recalcOrder(order, ctx); C.touch(order, user._id, 'items.add', `${added} item(s)`); await order.save({ session });
    return { order, tickets: sent.tickets, added };
  }).catch((e) => { throw pe(e); });
}

async function updateItem(businessId, user, orderId, itemId, input) {
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, orderId, session);
    C.assertOrderAccess(user, order, { write: true }); C.assertOpen(order); C.checkVersion(order, input.expectedVersion);
    const item = order.items.id(itemId); if (!item || item.status === 'CANCELLED') throw ApiError.notFound('Item not found', 'ITEM_NOT_FOUND');
    const sent = !['DRAFT'].includes(item.status);
    if (sent && (input.quantity !== undefined || input.seatNumber !== undefined || input.course !== undefined)) throw ApiError.conflict('This item is already sent. Cancel it (with a reason) and add it again, or add another line.', 'ITEM_ALREADY_SENT');
    if (!sent) { if (input.quantity !== undefined) item.quantity = input.quantity; if (input.seatNumber !== undefined) item.seatNumber = input.seatNumber; if (input.course !== undefined) item.course = input.course; }
    const noteChanged = (input.notes !== undefined && input.notes !== item.notes) || (input.allergyNotes !== undefined && input.allergyNotes !== item.allergyNotes);
    if (input.notes !== undefined) item.notes = input.notes; if (input.allergyNotes !== undefined) item.allergyNotes = input.allergyNotes;
    if (sent && noteChanged && ['PENDING', 'ACCEPTED', 'PREPARING', 'HELD'].includes(item.status) && (item.ticketId || (!ctx.ops.screen && item.status !== 'HELD'))) {
      if (ctx.ops.screen && item.ticketId) await kitchen.amend(order, [{ item, cancelled: false }], { ctx, session, reason: 'Instructions changed' });
      await prints.enqueueCancelSlip(order, [{ item, cancelled: false }], { ctx, session, reason: 'Instructions changed' });
    }
    C.recalcOrder(order, ctx); C.touch(order, user._id, 'item.update', item.name); await order.save({ session });
    return order;
  });
}

async function cancelItem(businessId, user, orderId, itemId, { reason, quantity, expectedVersion }) {
  const out = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, orderId, session);
    C.assertOrderAccess(user, order, { write: true }); C.assertOpen(order); C.checkVersion(order, expectedVersion);
    let item = order.items.id(itemId); if (!item || item.status === 'CANCELLED') throw ApiError.notFound('Item not found', 'ITEM_NOT_FOUND');
    if (item.parentItemId) throw ApiError.badRequest('Cancel the whole combo, not one component', 'COMBO_COMPONENT');
    const sentBefore = item.status !== 'DRAFT';
    if (sentBefore) { C.requireCan(user, 'restaurant.orders.void', 'Cancelling an item already sent to the kitchen needs a supervisor'); if (!reason || reason.trim().length < 3) throw ApiError.badRequest('Give a reason', 'REASON_REQUIRED'); }
    if (quantity && quantity < item.quantity) {                       // partial cancel: split the line
      const clone = item.toObject({ transform: false, virtuals: false }); clone._id = oidNew(); clone.quantity = quantity; clone.stockLines = clone.stockLines || [];
      item.quantity = Math.round((item.quantity - quantity) * 10000) / 10000;
      if (item.stockState === 'DEDUCTED' && item.stockLines?.length) { for (const l of clone.stockLines) { /* the cancelled share carries its proportional stock */ } const ratio = quantity / (quantity + item.quantity); clone.stockLines = item.stockLines.map((l) => ({ ingredientId: l.ingredientId, location: l.location, unitCost: l.unitCost, quantity: Math.round(l.quantity * ratio * 10000) / 10000, batches: (l.batches || []).map((b) => ({ batchId: b.batchId, quantity: Math.round(b.quantity * ratio * 10000) / 10000 })) })); item.stockLines = item.stockLines.map((l, k) => ({ ingredientId: l.ingredientId, location: l.location, unitCost: l.unitCost, quantity: Math.round((l.quantity - clone.stockLines[k].quantity) * 10000) / 10000, batches: (l.batches || []).map((b, j) => ({ batchId: b.batchId, quantity: Math.round((b.quantity - clone.stockLines[k].batches[j].quantity) * 10000) / 10000 })) })); }
      order.items.push(clone); item = order.items.id(clone._id);
      await bills.adjustBillsForItem(order, order.items.find((x) => String(x._id) === String(itemId)), { session, ctx, mode: 'QUANTITY' });
    }
    const group = [item, ...order.items.filter((x) => C.sameId(x.parentItemId, item._id))];
    const changes = [];
    for (const it of group) {
      const wasSent = it.status !== 'DRAFT'; const wasHeld = it.status === 'HELD'; const prepared = consumption.wasPrepared(it);
      const { wasted } = await consumption.settleCancelledItem(order, it, { ctx, userId: user._id, session, reason });
      it.cancelledAfterPrep = prepared; it.status = 'CANCELLED'; it.cancelledAt = new Date(); it.cancelledBy = user._id; it.cancelReason = reason;
      if (wasSent && (it.ticketId || (!ctx.ops.screen && !wasHeld))) changes.push({ item: it, cancelled: true });
      if (!it.parentItemId) await bills.adjustBillsForItem(order, it, { session, ctx, mode: 'CANCEL' });
    }
    if (changes.length && ctx.ops.screen) await kitchen.amend(order, changes.filter((c) => c.item.ticketId), { ctx, session, reason: `CANCELLED: ${reason}` });
    if (changes.length) await prints.enqueueCancelSlip(order, changes.filter((c) => !c.item.parentItemId), { ctx, session, reason });
    C.recalcOrder(order, ctx); C.touch(order, user._id, 'item.cancel', `${item.name}: ${reason || 'removed'}`, { itemId: item._id }); await order.save({ session });
    await C.audit({ businessId, branchId: order.branchId, userId: user._id, action: 'restaurant.item.cancel', entityType: 'RestaurantOrder', entityId: order._id, newValue: { item: item.name, quantity: item.quantity, reason, afterPrep: item.cancelledAfterPrep } }, session);
    return { order, sentBefore, item };
  });
  if (out.sentBefore) {
    const payload = { title: `Cancelled: ${out.item.name} (${out.order.tableName || out.order.orderNumber})`, message: `${user.name} cancelled ${out.item.quantity} x ${out.item.name}: ${reason}`, branchId: out.order.branchId, entityType: 'RestaurantOrder', entityId: out.order._id };
    C.notifyRoles(businessId, out.order.branchId, C.KITCHEN_ROLES, { ...payload, type: 'KITCHEN_CANCELLATION' });
    C.notifyManagement(businessId, { ...payload, type: 'RESTAURANT_VOID' });
  }
  return out.order;
}

async function sendOrder(businessId, user, id, { expectedVersion } = {}) {
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, id, session);
    C.assertOrderAccess(user, order, { write: true }); C.assertOpen(order); C.checkVersion(order, expectedVersion);
    const sent = await sendDrafts(order, ctx, user, session);
    if (sent.changed.length || order.items.some((i) => i.status === 'HELD' && i.sentAt)) { C.recalcOrder(order, ctx); C.touch(order, user._id, 'order.send', `${sent.changed.length} item(s) sent`); await order.save({ session }); }   // totals now include what was just sent
    return { order, tickets: sent.tickets, sent: sent.changed.length };
  });
}

async function fireCourse(businessId, user, id, { course }) {
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, id, session);
    C.assertOrderAccess(user, order, { write: true }); C.assertOpen(order);
    const sent = await sendDrafts(order, ctx, user, session, { fireCourse: course });
    if (!sent.changed.length) throw ApiError.conflict(`Nothing is held for course ${course}`, 'NOTHING_TO_FIRE');
    C.touch(order, user._id, 'course.fire', `Course ${course}`); await order.save({ session });
    return { order, tickets: sent.tickets };
  });
}

async function serveItems(businessId, user, id, { itemIds, allReady }) {
  const order0 = await C.loadOrder(businessId, id); C.assertOrderAccess(user, order0, { write: true });
  const ids = allReady ? order0.items.filter((i) => i.status === 'READY').map((i) => i._id) : itemIds;
  for (const itemId of ids) await kitchen.setItemStatus(businessId, user, id, itemId, 'SERVED');
  return C.loadOrder(businessId, id);
}

/** NO kitchen screen: front-of-house staff mark food READY by hand (delivery, pickup, take-away, counter). Refused when a kitchen screen exists. */
async function markReady(businessId, user, id, { itemIds, all = false } = {}) {
  const ctx0 = await C.getContext(businessId);
  if (ctx0.ops.screen) throw ApiError.conflict('This restaurant has a kitchen screen: the kitchen marks food ready.', 'USE_KITCHEN_SCREEN');
  if (!C.can(user, 'restaurant.orders.create') && !C.can(user, 'restaurant.bills.view') && !C.can(user, 'restaurant.kitchen.update')) throw ApiError.forbidden('Not allowed to mark food ready', 'PERMISSION_DENIED');
  const order0 = await C.loadOrder(businessId, id); C.assertOrderAccess(user, order0, { write: true }); C.assertOpen(order0);
  const open = order0.items.filter((i) => ['PENDING', 'ACCEPTED', 'PREPARING'].includes(i.status));
  const ids = all || !itemIds || !itemIds.length ? open.map((i) => i._id) : itemIds;
  if (!ids.length) throw ApiError.conflict('Nothing is waiting to be marked ready', 'NOTHING_TO_MARK_READY');
  for (const itemId of ids) await kitchen.setItemStatus(businessId, user, id, itemId, 'READY', { frontDesk: true });
  return C.loadOrder(businessId, id);
}

// ------------------------------------------------------------------ comps / notes
async function compItems(businessId, user, id, { itemIds, reason, kind = 'COMPLIMENTARY', remove = false }) {
  C.requireCan(user, 'restaurant.orders.comp', 'Only a supervisor can give complimentary items');
  const out = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, id, session); C.assertBranchAccess(user, order.branchId); C.assertOpen(order);
    for (const itemId of itemIds) {
      const i = order.items.id(itemId); if (!i || i.status === 'CANCELLED') throw ApiError.notFound('Item not found', 'ITEM_NOT_FOUND');
      if (i.parentItemId) throw ApiError.badRequest('Comp the whole combo', 'COMBO_COMPONENT');
      i.isComplimentary = !remove; i.compReason = remove ? undefined : reason; i.compKind = remove ? undefined : kind; i.compBy = remove ? undefined : user._id;
      if (!remove) i.discount = 0;
      await bills.adjustBillsForItem(order, i, { session, ctx, mode: 'REBUILD' });
    }
    C.recalcOrder(order, ctx); C.touch(order, user._id, remove ? 'item.uncomp' : 'item.comp', reason, { itemIds }); await order.save({ session });
    await C.audit({ businessId, branchId: order.branchId, userId: user._id, action: remove ? 'restaurant.item.uncomp' : 'restaurant.item.comp', entityType: 'RestaurantOrder', entityId: order._id, newValue: { itemIds, reason, kind } }, session);
    return order;
  });
  if (!remove) C.notifyManagement(businessId, { type: 'RESTAURANT_COMP', title: `Complimentary items on ${out.tableName || out.orderNumber}`, message: `${user.name}: ${reason}`, branchId: out.branchId, entityType: 'RestaurantOrder', entityId: out._id });
  return out;
}

async function updateOrder(businessId, user, id, { guestCount, customerId, notes, priority, customerName, customerPhone, expectedVersion }) {
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, id, session); C.assertOrderAccess(user, order, { write: true }); C.assertOpen(order); C.checkVersion(order, expectedVersion);
    if (guestCount !== undefined) { order.guestCount = guestCount; if (order.tableId) await RestaurantTable.updateOne({ _id: order.tableId }, { $set: { guestCount } }, { session }); }
    if (customerId !== undefined) { if (customerId) { const c = await Customer.findOne({ _id: customerId, businessId, status: 'active' }).session(session); if (!c) throw ApiError.badRequest('Customer not found', 'INVALID_CUSTOMER'); order.customerId = c._id; order.customerName = c.name; order.customerPhone = c.phone; } else { order.customerId = undefined; } }
    if (customerName !== undefined) order.customerName = customerName; if (customerPhone !== undefined) order.customerPhone = customerPhone;
    if (notes !== undefined) order.notes = notes;
    if (priority !== undefined) { order.priority = priority; await KitchenTicket.updateMany({ orderId: order._id, status: { $in: ['NEW', 'ACCEPTED', 'PREPARING'] } }, { $set: { priority } }, { session }); }
    C.touch(order, user._id, 'order.update'); await order.save({ session }); return order;
  });
}

// ------------------------------------------------------------------ moving orders around
async function transferTable(businessId, user, id, { toTableId, expectedVersion }) {
  C.requireCan(user, 'restaurant.orders.manage', 'Only a head waiter or supervisor can move an order');
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, id, session); C.assertBranchAccess(user, order.branchId); C.assertOpen(order); C.checkVersion(order, expectedVersion);
    if (order.orderType !== 'DINE_IN' || !order.tableId) throw ApiError.badRequest('Only table orders can be moved', 'NOT_A_TABLE_ORDER');
    if (C.sameId(order.tableId, toTableId)) throw ApiError.badRequest('Already at that table', 'SAME_TABLE');
    const dest = await RestaurantTable.findOne({ _id: toTableId, businessId }).session(session);
    if (!dest || !C.sameId(dest.branchId, order.branchId)) throw ApiError.badRequest('Table not found at this branch', 'TABLE_NOT_FOUND');
    const claimed = await tables.claimTable({ businessId, tableId: toTableId, orderId: order._id, guestCount: order.guestCount, waiterId: order.waiterId, allowReserved: true, allowCleaning: true, session });
    const old = order.tableId; const oldName = order.tableName;
    const oldT = await RestaurantTable.findById(old).session(session);
    if (oldT?.combinedWith?.length) await RestaurantTable.updateMany({ _id: { $in: oldT.combinedWith } }, { $set: { combinedInto: null, status: 'AVAILABLE' } }, { session });
    await RestaurantTable.updateOne({ _id: old }, { $set: { combinedWith: [] } }, { session });
    await tables.releaseTable({ businessId, tableId: old, settings: ctx.settings, session });
    order.tableId = claimed._id; order.tableName = claimed.name;
    await KitchenTicket.updateMany({ orderId: order._id, status: { $in: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] } }, { $set: { tableName: claimed.name } }, { session });
    await RestaurantBill.updateMany({ orderId: order._id }, { $set: { tableName: claimed.name } }, { session });
    C.touch(order, user._id, 'order.transfer_table', `${oldName} -> ${claimed.name}`); await order.save({ session });
    await C.audit({ businessId, branchId: order.branchId, userId: user._id, action: 'restaurant.order.transfer_table', entityType: 'RestaurantOrder', entityId: order._id, oldValue: { table: oldName }, newValue: { table: claimed.name } }, session);
    return order;
  }).catch((e) => { throw e.code === 11000 ? ApiError.conflict('That table already has an open order', 'TABLE_OCCUPIED') : e; });
}

async function reassignWaiter(businessId, user, id, { waiterId, note }) {
  C.requireCan(user, 'restaurant.orders.manage', 'Only a head waiter or supervisor can reassign an order');
  const out = await C.inTx(async (session) => {
    const order = await C.loadOrder(businessId, id, session); C.assertBranchAccess(user, order.branchId); C.assertOpen(order);
    const w = await User.findOne({ _id: waiterId, businessId, status: 'active' }).select('name branchIds role').session(session); if (!w) throw ApiError.badRequest('Waiter not found', 'USER_NOT_FOUND');
    const from = order.waiterName; order.waiterId = w._id; order.waiterName = w.name;
    if (order.tableId) await RestaurantTable.updateOne({ _id: order.tableId }, { $set: { waiterId: w._id } }, { session });
    await RestaurantBill.updateMany({ orderId: order._id }, { $set: { waiterId: w._id, waiterName: w.name } }, { session });
    C.touch(order, user._id, 'order.reassign', `${from} -> ${w.name}`, { note }); await order.save({ session });
    await C.audit({ businessId, branchId: order.branchId, userId: user._id, action: 'restaurant.order.reassign', entityType: 'RestaurantOrder', entityId: order._id, oldValue: { waiter: from }, newValue: { waiter: w.name, note } }, session);
    return order;
  });
  C.notifyUser(businessId, waiterId, { type: 'ORDER_HANDOVER', title: `Order handed to you: ${out.tableName || out.orderNumber}`, message: `${user.name} handed ${out.tableName || out.orderNumber} over to you.`, branchId: out.branchId, entityType: 'RestaurantOrder', entityId: out._id });
  return out;
}

async function mergeOrders(businessId, user, id, { sourceOrderId }) {
  C.requireCan(user, 'restaurant.orders.manage', 'Only a head waiter or supervisor can merge orders');
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const target = await C.loadOrder(businessId, id, session); const source = await C.loadOrder(businessId, sourceOrderId, session);
    if (String(target._id) === String(source._id)) throw ApiError.badRequest('Choose a different order', 'SAME_ORDER');
    C.assertBranchAccess(user, target.branchId); C.assertOpen(target); C.assertOpen(source);
    if (!C.sameId(target.branchId, source.branchId)) throw ApiError.badRequest('Orders are at different branches', 'BRANCH_MISMATCH');
    const sb = await RestaurantBill.find({ orderId: source._id, status: { $nin: ['VOID'] } }).session(session);
    if (sb.some((b) => b.payments.length || b.status === 'PAID')) throw ApiError.conflict('The order being merged already has payments', 'HAS_PAYMENTS');
    for (const b of sb) { b.status = 'VOID'; b.voidReason = `Merged into ${target.orderNumber}`; b.voidedBy = user._id; await b.save({ session }); }
    for (const i of source.items) target.items.push(i.toObject({ transform: false, virtuals: false }));
    target.guestCount += source.guestCount; if (target.billStatus !== 'NONE') target.billStatus = 'NONE';
    await RestaurantBill.updateMany({ orderId: target._id, status: 'OPEN', 'payments.0': { $exists: false } }, { $set: { status: 'VOID', voidReason: 'Orders merged: regenerate the bill', voidedBy: user._id } }, { session });
    await KitchenTicket.updateMany({ orderId: source._id }, { $set: { orderId: target._id, orderNumber: target.orderNumber, tableName: target.tableName } }, { session });
    source.status = 'CANCELLED'; source.cancelledAt = new Date(); source.cancelledBy = user._id; source.cancelReason = `Merged into ${target.orderNumber}`; source.items.forEach((i) => { i.status = i.status === 'CANCELLED' ? 'CANCELLED' : i.status; });
    source.items = []; C.recalcOrder(source, ctx); C.touch(source, user._id, 'order.merged_out', target.orderNumber); await source.save({ session });
    if (source.tableId) await tables.releaseTable({ businessId, tableId: source.tableId, settings: ctx.settings, session });
    C.recalcOrder(target, ctx); C.touch(target, user._id, 'order.merge', source.orderNumber); await target.save({ session });
    await C.audit({ businessId, branchId: target.branchId, userId: user._id, action: 'restaurant.order.merge', entityType: 'RestaurantOrder', entityId: target._id, newValue: { merged: source.orderNumber } }, session);
    return target;
  });
}

/** A waiter takes an order a guest started by QR code (it has no waiter yet). */
async function claimOrder(businessId, user, id) {
  C.requireCan(user, 'restaurant.orders.create');
  return C.inTx(async (session) => {
    const order = await C.loadOrder(businessId, id, session); C.assertBranchAccess(user, order.branchId); C.assertOpen(order);
    if (order.waiterId && !C.sameId(order.waiterId, user._id)) throw ApiError.conflict(`Already served by ${order.waiterName || 'another waiter'}`, 'ORDER_HAS_WAITER');
    order.waiterId = user._id; order.waiterName = user.name;
    if (order.tableId) await RestaurantTable.updateOne({ _id: order.tableId }, { $set: { waiterId: user._id } }, { session });
    await RestaurantBill.updateMany({ orderId: order._id }, { $set: { waiterId: user._id, waiterName: user.name } }, { session });
    C.touch(order, user._id, 'order.claim', user.name); await order.save({ session }); return order;
  });
}

async function requestBill(businessId, user, id) {
  const order = await C.inTx(async (session) => {
    const o = await C.loadOrder(businessId, id, session); C.assertOrderAccess(user, o, { write: true }); C.assertOpen(o);
    if (!o.items.some((i) => !['CANCELLED', 'DRAFT'].includes(i.status))) throw ApiError.badRequest('There is nothing to bill yet', 'NOTHING_TO_BILL');
    o.billRequestedAt = new Date(); if (o.billStatus === 'NONE') o.billStatus = 'REQUESTED';
    if (o.tableId) await RestaurantTable.updateOne({ _id: o.tableId, status: 'OCCUPIED' }, { $set: { status: 'AWAITING_BILL', statusSince: new Date() } }, { session });
    C.touch(o, user._id, 'bill.requested'); await o.save({ session }); return o;
  });
  C.notifyRoles(businessId, order.branchId, C.CASHIER_ROLES, { type: 'BILL_REQUESTED', title: `Bill requested: ${order.tableName || order.orderNumber}`, message: `${user.name} asked for the bill for ${order.tableName || order.orderNumber}.`, entityType: 'RestaurantOrder', entityId: order._id });
  return order;
}

async function requestAssistance(businessId, user, id, { reason, type = 'ASSISTANCE' }) {
  const order = await C.loadOrder(businessId, id); C.assertOrderAccess(user, order, { write: true });
  const inc = await ServiceIncident.create({ businessId, branchId: order.branchId, type, orderId: order._id, orderNumber: order.orderNumber, tableName: order.tableName, description: reason, raisedBy: user._id, severity: type === 'ALLERGY' ? 'HIGH' : 'MEDIUM' });
  await RestaurantOrder.updateOne({ _id: order._id }, { $set: { assistance: { at: new Date(), by: user._id, reason } } });
  C.notifyRoles(businessId, order.branchId, C.FLOOR_LEAD_ROLES, { type: 'WAITER_ASSISTANCE', title: `${order.tableName || order.orderNumber} needs help`, message: `${user.name}: ${reason}`, entityType: 'RestaurantOrder', entityId: order._id });
  return inc;
}

async function cancelOrder(businessId, user, id, { reason }) {
  C.requireCan(user, 'restaurant.orders.void', 'Only a supervisor can cancel an order');
  const out = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, id, session); C.assertBranchAccess(user, order.branchId); C.assertOpen(order);
    const bl = await RestaurantBill.find({ orderId: order._id, status: { $ne: 'VOID' } }).session(session);
    if (bl.some((b) => b.payments.length || b.status === 'PAID')) throw ApiError.conflict('This order has payments. Refund the bill instead of cancelling the order.', 'HAS_PAYMENTS');
    for (const b of bl) { b.status = 'VOID'; b.voidReason = `Order cancelled: ${reason}`; b.voidedBy = user._id; await b.save({ session }); }
    const changes = [];
    for (const it of order.items) {
      if (it.status === 'CANCELLED') continue;
      const wasSent = it.status !== 'DRAFT'; const wasHeld = it.status === 'HELD'; const prepared = consumption.wasPrepared(it);
      await consumption.settleCancelledItem(order, it, { ctx, userId: user._id, session, reason });
      it.cancelledAfterPrep = prepared; it.status = 'CANCELLED'; it.cancelledAt = new Date(); it.cancelledBy = user._id; it.cancelReason = reason;
      if (wasSent && (it.ticketId || (!ctx.ops.screen && !wasHeld)) && !it.parentItemId) changes.push({ item: it, cancelled: true });
    }
    if (changes.length && ctx.ops.screen) await kitchen.amend(order, changes.filter((c) => c.item.ticketId), { ctx, session, reason: `ORDER CANCELLED: ${reason}` });
    if (changes.length) await prints.enqueueCancelSlip(order, changes, { ctx, session, reason: `ORDER CANCELLED: ${reason}` });
    order.status = 'CANCELLED'; order.cancelledAt = new Date(); order.cancelledBy = user._id; order.cancelReason = reason; order.billStatus = 'NONE';
    if (order.tableId) await tables.releaseTable({ businessId, tableId: order.tableId, settings: ctx.settings, session });
    if (order.reservationId) await Reservation.updateOne({ _id: order.reservationId }, { $set: { status: 'ARRIVED' } }, { session });
    C.recalcOrder(order, ctx); C.touch(order, user._id, 'order.cancel', reason); await order.save({ session });
    await C.audit({ businessId, branchId: order.branchId, userId: user._id, action: 'restaurant.order.cancel', entityType: 'RestaurantOrder', entityId: order._id, newValue: { reason } }, session);
    return order;
  });
  if (!(out.source === 'KIOSK' && !out.firstSentAt)) C.notifyRoles(businessId, out.branchId, C.KITCHEN_ROLES, { type: 'KITCHEN_CANCELLATION', title: `Order cancelled: ${out.tableName || out.orderNumber}`, message: `${user.name}: ${reason}`, entityType: 'RestaurantOrder', entityId: out._id });
  return out;
}

async function reopenOrder(businessId, user, id, { reason }) {
  C.requireCan(user, 'restaurant.bills.reopen', 'Reopening a closed order needs a manager');
  return C.inTx(async (session) => {
    const order = await C.loadOrder(businessId, id, session); C.assertBranchAccess(user, order.branchId);
    if (order.status !== 'CLOSED') throw ApiError.conflict(`Order is ${order.status}`, 'INVALID_ORDER_STATE');
    if (order.tableId) await tables.claimTable({ businessId, tableId: order.tableId, orderId: order._id, guestCount: order.guestCount, waiterId: order.waiterId, allowReserved: true, allowCleaning: true, session });
    order.status = 'OPEN'; order.closedAt = undefined; order.billStatus = 'PARTIAL';
    C.touch(order, user._id, 'order.reopen', reason); await order.save({ session });
    await C.audit({ businessId, branchId: order.branchId, userId: user._id, action: 'restaurant.order.reopen', entityType: 'RestaurantOrder', entityId: order._id, newValue: { reason } }, session);
    return order;
  });
}

// ------------------------------------------------------------------ delivery and pickup
async function assignRider(businessId, user, id, { riderId }) {
  const out = await C.inTx(async (session) => {
    const order = await C.loadOrder(businessId, id, session); C.assertBranchAccess(user, order.branchId); C.assertOpen(order);
    if (order.orderType !== 'DELIVERY') throw ApiError.badRequest('Not a delivery order', 'NOT_DELIVERY');
    if (['OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.delivery.status)) throw ApiError.conflict(`Delivery is already ${order.delivery.status === 'DELIVERED' ? 'delivered' : 'on the road'}. It cannot be given to another rider.`, 'INVALID_DELIVERY_STATE');
    const r = await User.findOne({ _id: riderId, businessId, status: 'active', role: ROLES.DELIVERY_RIDER }).select('name phone').session(session); if (!r) throw ApiError.badRequest('Rider not found', 'USER_NOT_FOUND');
    order.delivery.riderId = r._id; order.delivery.riderName = r.name; order.delivery.riderPhone = r.phone; order.delivery.status = 'ASSIGNED'; order.delivery.assignedAt = new Date();
    order.delivery.pickedUpAt = undefined; order.delivery.arrivedAt = undefined;          // a new rider starts from the restaurant
    C.touch(order, user._id, 'delivery.assign', r.name); await order.save({ session }); return order;
  });
  C.notifyUser(businessId, riderId, { type: 'DELIVERY_ASSIGNED', title: `Delivery ${out.orderNumber}`, message: `${out.delivery.address}`, branchId: out.branchId, entityType: 'RestaurantOrder', entityId: out._id });
  require('../delivery/tracking.service').onAssigned(out, { _id: out.delivery.riderId, name: out.delivery.riderName }).catch(() => {});   // rider's phone + the customer's tracking page
  return out;
}

async function setDeliveryStatus(businessId, user, id, { status, reason }) {
  const order = await C.loadOrder(businessId, id); C.assertBranchAccess(user, order.branchId);
  if (order.orderType !== 'DELIVERY') throw ApiError.badRequest('Not a delivery order', 'NOT_DELIVERY');
  const isRider = C.sameId(order.delivery.riderId, user._id);
  if (!isRider && !C.can(user, 'restaurant.delivery.manage')) throw ApiError.forbidden('This delivery is not yours', 'PERMISSION_DENIED');
  const allowed = { ASSIGNED: ['OUT_FOR_DELIVERY'], OUT_FOR_DELIVERY: ['DELIVERED', 'FAILED'], PENDING: ['ASSIGNED'], FAILED: ['OUT_FOR_DELIVERY'] };
  if (!(allowed[order.delivery.status] || []).includes(status)) throw ApiError.conflict(`Delivery is ${order.delivery.status}`, 'INVALID_DELIVERY_STATE');
  if (status === 'OUT_FOR_DELIVERY' && !order.items.some((i) => i.status === 'READY' || i.status === 'SERVED')) throw ApiError.conflict('The food is not ready', 'ITEMS_NOT_READY');
  if (status === 'DELIVERED') await require('../delivery/delivery-payment.service').assertCanDeliver(order, user);     // a rider cannot finish a delivery that has not been paid
  const now = new Date();
  order.delivery.status = status; if (status === 'OUT_FOR_DELIVERY') order.delivery.outForDeliveryAt = now; if (status === 'DELIVERED') order.delivery.deliveredAt = now; if (status === 'FAILED') order.delivery.failReason = reason;
  if (status === 'OUT_FOR_DELIVERY') order.items.forEach((i) => { if (i.status === 'READY') { i.status = 'SERVED'; i.servedAt = now; } });
  C.touch(order, user._id, `delivery.${status.toLowerCase()}`, reason); await order.save();
  if (status === 'DELIVERED' || status === 'OUT_FOR_DELIVERY') await bills.tryCloseOrder(businessId, id, user);
  const fresh = await C.loadOrder(businessId, id);
  await require('../delivery/tracking.service').onStatus(fresh, status, user, reason);      // customer alert, live board, cashier notice (never throws)
  return fresh;
}

async function collectPickup(businessId, user, id, { collectedBy }) {
  const order = await C.loadOrder(businessId, id); C.assertOrderAccess(user, order, { write: true }); C.assertOpen(order);
  if (!['PICKUP', 'TAKEAWAY'].includes(order.orderType)) throw ApiError.badRequest('Not a pickup order', 'NOT_PICKUP');
  if (!order.items.some((i) => ['READY', 'SERVED'].includes(i.status))) throw ApiError.conflict('The order is not ready', 'ITEMS_NOT_READY');
  const now = new Date(); order.items.forEach((i) => { if (i.status === 'READY') { i.status = 'SERVED'; i.servedAt = now; } });
  order.pickup = { status: 'COLLECTED', collectedAt: now, collectedBy }; C.touch(order, user._id, 'pickup.collected', collectedBy); await order.save();
  await bills.tryCloseOrder(businessId, id, user);
  return C.loadOrder(businessId, id);
}

async function myDeliveries(businessId, user, { status }) {
  const f = { businessId, orderType: 'DELIVERY', status: 'OPEN', 'delivery.riderId': user._id }; if (status) f['delivery.status'] = status;
  return RestaurantOrder.find(f).select('orderNumber delivery totals customerName customerPhone items.name items.quantity').sort({ createdAt: -1 });
}
async function listDeliveries(businessId, user, { branchId, status }) {
  // DELIVERY and PICKUP orders: the Delivery & pickup screen has a tab for each (pickups were missing because orderType was never selected)
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)), orderType: { $in: ['DELIVERY', 'PICKUP'] }, status: 'OPEN' }; if (status) f['delivery.status'] = status;
  return RestaurantOrder.find(f).select('orderNumber orderType billStatus pickup pickupNumber delivery totals customerName customerPhone createdAt').sort({ createdAt: 1 });
}

// ------------------------------------------------------------------ offline replay
/** Applies queued offline operations in order. Each is idempotent (clientRef / clientItemId), conflicts are reported, never overwritten. */
async function syncBatch(businessId, user, ops) {
  const results = []; const refs = new Map();
  const find = async (ref) => {
    if (ref?.orderId) return ref.orderId;
    const key = `${ref?.deviceId}:${ref?.clientRef}`; if (refs.has(key)) return refs.get(key);
    const o = await RestaurantOrder.findOne({ businessId, deviceId: ref?.deviceId, clientRef: ref?.clientRef }).select('_id'); if (!o) throw ApiError.notFound('Order for this operation was not found', 'ORDER_NOT_FOUND'); return o._id;
  };
  for (const op of ops) {
    try {
      let order;
      if (op.type === 'createOrder') { const r = await createOrder(businessId, user, op.payload); refs.set(`${op.payload.deviceId}:${op.payload.clientRef}`, r.order._id); order = r.order; }
      else {
        const id = await find(op.orderRef);
        if (op.type === 'addItems') order = (await addItems(businessId, user, id, { ...op.payload, expectedVersion: undefined })).order;
        else if (op.type === 'send') order = (await sendOrder(businessId, user, id)).order;
        else if (op.type === 'serve') order = await serveItems(businessId, user, id, op.payload);
        else if (op.type === 'cancelItem') order = await cancelItem(businessId, user, id, op.itemId, op.payload);
        else throw ApiError.badRequest('Unknown operation', 'UNKNOWN_OP');
      }
      results.push({ clientOpId: op.clientOpId, ok: true, orderId: order._id, version: order.version });
    } catch (e) { results.push({ clientOpId: op.clientOpId, ok: false, code: e.code || 'ERROR', message: e.message, conflict: e.code === 'ORDER_VERSION_CONFLICT' || e.code === 'TABLE_OCCUPIED' || e.code === 'ORDER_NOT_OPEN' }); }
  }
  return results;
}

module.exports = {
  createOrder, getOrder, listOrders, addItems, updateItem, cancelItem, sendOrder, fireCourse, serveItems, compItems, updateOrder, transferTable,
  markReady, reassignWaiter, mergeOrders, claimOrder, requestBill, requestAssistance, cancelOrder, reopenOrder, assignRider, setDeliveryStatus, collectPickup, myDeliveries, listDeliveries, syncBatch,
};
