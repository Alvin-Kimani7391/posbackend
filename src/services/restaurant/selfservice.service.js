/**
 * Self-service kiosk: a customer orders and pays on a touchscreen. This file only ORCHESTRATES the existing restaurant system:
 *   order.service (orders, items, fireCourse -> kitchen/bar tickets), bill.service (bill + payment + Sale), mpesa.service (STK push),
 *   table.service (table claim), print.service/PrintJob (paper), cashier desk (restaurant.routes /self-service/*).
 *
 * THE MONEY RULE: a kiosk order is created with every item HELD. HELD items are billable (so the bill and the total exist)
 * but never create a kitchen/bar ticket. They are released with the existing fireCourse() ONLY after the server has recorded a
 * verified payment: an M-PESA transaction the provider confirmed (callback / status poll / sweep) or an authorised cashier's cash confirmation.
 * Nothing the browser sends (price, total, payment status, business id, cashier) is ever trusted.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantTable = require('../../models/RestaurantTable');
const RestaurantBill = require('../../models/RestaurantBill');
const RestaurantSettings = require('../../models/RestaurantSettings');
const MpesaTransaction = require('../../models/MpesaTransaction');
const IntegrationSettings = require('../../models/IntegrationSettings');
const MenuItem = require('../../models/MenuItem');
const ModifierGroup = require('../../models/ModifierGroup');
const Branch = require('../../models/Branch');
const PrintJob = require('../../models/PrintJob');
const ApiError = require('../../utils/ApiError');
const P = require('../../utils/restaurantPricing');
const B = require('../../utils/restaurantBilling');
const mpesa = require('../mpesa.service');
const menuSvc = require('./menu.service');
const orders = require('./order.service');
const bills = require('./bill.service');
const H = require('../hospitality/common');       // restaurant common + guestActor + getAccContext + rand

const PHONE = /^(?:\+?254|0)?[17]\d{8}$/;
const UNPAID = ['PENDING', 'AWAITING_CASH'];
const money = (c) => (c === null || c === undefined ? null : Math.round(c) / 100);
const fmtN = (c) => (Math.round(c || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const oid = () => new mongoose.Types.ObjectId();

// ------------------------------------------------------------------ kiosk token (signed, carries only the business + a version)
const secret = () => process.env.QR_SECRET || require('../../config/env').jwt.secret;
const sig = (id, ver) => crypto.createHmac('sha256', secret()).update(`KIOSK:${id}:${ver}`).digest('base64url').slice(0, 22);
const makeToken = (businessId, ver = 1) => `k_${businessId}_${ver}_${sig(businessId, ver)}`;
function parseToken(token) {
  const m = /^k_([a-f0-9]{24})_(\d{1,6})_([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  const bad = () => ApiError.notFound('This kiosk link is not valid any more. Please ask a member of staff.', 'KIOSK_INVALID');
  if (!m) throw bad();
  const want = Buffer.from(sig(m[1], m[2])); const got = Buffer.from(m[3]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw bad();
  return { businessId: m[1], ver: Number(m[2]) };
}

async function mpesaOn(businessId) {
  const s = await IntegrationSettings.findOne({ businessId }).select('mpesa.enabled mpesa.channelId');
  return !!(s && s.mpesa && s.mpesa.enabled && s.mpesa.channelId);
}

/** Token -> business, branch and the owner's switches. EVERY public call goes through here, so a disabled kiosk rejects direct API calls too. */
async function resolve(token, { allowDisabled = false } = {}) {
  const { businessId, ver } = parseToken(token);
  let ctx; try { ctx = await H.getAccContext(businessId); } catch (e) { throw ApiError.notFound('This kiosk link is not valid any more.', 'KIOSK_INVALID'); }
  const ss = ctx.settings.selfService || {};
  if ((ss.kioskVersion || 1) !== ver) throw ApiError.notFound('This kiosk link is not valid any more. Please ask a member of staff.', 'KIOSK_INVALID');
  if (!allowDisabled) {
    if (ctx.business.status && ctx.business.status !== 'active') throw ApiError.forbidden('This business is not taking orders right now.', 'BUSINESS_INACTIVE');
    if (!ctx.features.ordering) throw ApiError.forbidden('Ordering is not available here.', 'FEATURE_DISABLED');
    if (!ss.enabled) throw ApiError.forbidden('Self-service ordering is switched off. Please order at the counter.', 'SELF_SERVICE_DISABLED');
  }
  if (!ss.branchId) throw ApiError.conflict('Self-service is not set up for a branch yet. Please order at the counter.', 'SELF_SERVICE_NOT_CONFIGURED');
  const branch = await Branch.findOne({ _id: ss.branchId, businessId }).select('name phone code');
  if (!branch) throw ApiError.conflict('Self-service branch is not valid. Please order at the counter.', 'SELF_SERVICE_NOT_CONFIGURED');
  return { businessId, branchId: branch._id, branch, ctx, ss };
}
const cashOn = (r) => !!r.ss.cash;
const mpesaAllowed = async (r) => !!r.ss.mpesa && (await mpesaOn(r.businessId));
function assertType(r, orderType) {
  if (orderType === 'DINE_IN' && !r.ss.dineIn) throw ApiError.badRequest('Dine-in is not available on this kiosk.', 'ORDER_TYPE_DISABLED');
  if (orderType === 'TAKEAWAY' && !r.ss.takeAway) throw ApiError.badRequest('Take away is not available on this kiosk.', 'ORDER_TYPE_DISABLED');
}

// ------------------------------------------------------------------ read-only screens
async function context(token) {
  const r = await resolve(token); const { ctx, ss, branch } = r;
  return {
    business: { name: ctx.business.name, logo: ctx.business.logo, currency: ctx.business.currency, timezone: ctx.timeZone },
    branch: branch.name,
    options: { printAvailable: !!ctx.ops.route('CASHIER'), dineIn: !!ss.dineIn, takeAway: !!ss.takeAway, mpesa: await mpesaAllowed(r), cash: cashOn(r), tablesRequired: !!ctx.features.tables, taxInclusive: ctx.taxInclusive },
    welcome: ss.welcomeMessage || undefined,
  };
}

/** Real tables for this branch, with their real state. Only AVAILABLE ones can be picked. */
async function tables(token) {
  const r = await resolve(token); assertType(r, 'DINE_IN');
  if (!r.ctx.features.tables) return { required: false, tables: [] };
  const list = await RestaurantTable.find({ businessId: r.businessId, branchId: r.branchId, active: true, combinedInto: null }).populate('areaId', 'name').sort({ name: 1 });
  return {
    required: true,
    tables: list.map((t) => {
      const selectable = t.status === 'AVAILABLE' && !t.currentOrderId;
      return { id: t._id, name: t.name, seats: t.seats, area: t.areaId && t.areaId.name, state: t.status === 'RESERVED' ? 'RESERVED' : selectable ? 'AVAILABLE' : 'OCCUPIED', selectable };
    }),
  };
}

async function menu(token, { orderType = 'TAKEAWAY' } = {}) {
  const r = await resolve(token); assertType(r, orderType);
  const actor = await H.guestActor(r.businessId);
  const m = await menuSvc.getMenu(r.businessId, actor, { branchId: r.branchId, orderType });
  const clean = (i) => ({
    id: i._id, name: i.name, description: i.description, image: i.image, price: i.effectivePrice, promoLabel: i.promoLabel, available: i.available !== false, unavailableReason: i.unavailableReason,
    allergens: i.allergens, requireVariant: i.requireVariant, isCombo: i.isCombo,
    variants: (i.variants || []).filter((v) => v.active !== false).map((v) => ({ id: v._id, name: v.name, price: v.price ?? null, priceDelta: v.priceDelta ?? 0 })),
    modifierGroups: (i.modifierGroups || []).map((g) => ({ id: g._id, name: g.name, required: g.required, min: g.min, max: g.max, allowQuantity: g.allowQuantity, options: (g.options || []).filter((o) => o.active !== false && !o.soldOut).map((o) => ({ id: o._id, name: o.name, priceDelta: money(o.priceDelta), allergens: o.allergens })) })),
    comboGroups: i.isCombo ? (i.comboGroups || []).map((g) => ({ name: g.name, min: g.min, max: g.max, options: g.options.map((o) => ({ menuItemId: o.menuItemId, priceDelta: o.priceDelta })) })) : undefined,
  });
  return { currency: r.ctx.business.currency, generatedAt: m.generatedAt, categories: m.categories.map((c) => ({ id: c._id, name: c.name, items: c.items.map(clean) })) };
}

// ------------------------------------------------------------------ cart: priced and validated on the server
async function priceCart(r, orderType, items) {
  const { businessId, branchId, ctx } = r; const lines = []; const fake = [];
  for (const it of items) {
    const mi = await MenuItem.findOne({ _id: it.menuItemId, businessId, status: 'active' });
    if (!mi) throw ApiError.badRequest('An item in your cart is no longer on the menu. Please remove it.', 'MENU_ITEM_NOT_FOUND');
    const av = P.availability(mi, { branchId, timeZone: ctx.timeZone });
    if (!av.ok) throw ApiError.badRequest(`${mi.name} is not available right now. Please remove it from your cart.`, av.reason || 'ITEM_UNAVAILABLE');
    const groups = await ModifierGroup.find({ businessId, _id: { $in: mi.modifierGroupIds } });
    let priced; try { priced = P.priceItem(mi, groups, { orderType, branchId, variantId: it.variantId, modifiers: it.modifiers || [], timeZone: ctx.timeZone }); } catch (e) { throw ApiError.badRequest(e.message, e.code || 'INVALID_ITEM'); }
    if (priced.substitutionApproval) throw ApiError.badRequest(`${mi.name}: that change needs a member of staff.`, 'NEEDS_STAFF');
    let comboDelta = 0;
    if (mi.isCombo) { try { comboDelta = P.resolveCombo(mi, it.comboPicks || []).reduce((s, c) => s + c.priceDelta * c.quantity, 0); } catch (e) { throw ApiError.badRequest(e.message, e.code || 'INVALID_COMBO'); } }
    const unitPrice = priced.unitPrice + comboDelta;
    fake.push({ _id: oid(), menuItemId: mi._id, name: mi.name, quantity: it.quantity, unitPrice, taxRate: mi.taxRate, serviceChargeable: mi.serviceChargeable, status: 'HELD' });
    lines.push({ menuItemId: mi._id, name: mi.name, variantName: priced.variantName, quantity: it.quantity, unitPrice: money(unitPrice), lineTotal: money(Math.round(unitPrice * it.quantity)) });
  }
  const t = B.orderTotals(fake, { taxInclusive: ctx.taxInclusive, ...H.scConfig(ctx.settings, orderType) });
  return { lines, totals: { itemsTotal: money(t.itemsTotal), serviceCharge: money(t.serviceCharge), tax: money(t.tax), total: money(t.total), totalCents: t.total } };
}

/** Table must be free right now (checked again at checkout, and atomically again when the order claims it). */
async function assertTableFree(r, tableId) {
  if (!r.ctx.features.tables) return null;
  if (!tableId) throw ApiError.badRequest('Please choose a table.', 'TABLE_REQUIRED');
  const t = await RestaurantTable.findOne({ _id: tableId, businessId: r.businessId, branchId: r.branchId, active: true });
  if (!t) throw ApiError.badRequest('That table does not exist here.', 'TABLE_NOT_FOUND');
  if (t.combinedInto) throw ApiError.conflict(`Table ${t.name} is part of a bigger group. Please pick another.`, 'TABLE_UNAVAILABLE');
  if (t.status !== 'AVAILABLE' || t.currentOrderId) throw ApiError.conflict(`Table ${t.name} is ${t.status === 'RESERVED' ? 'reserved' : 'taken'} now. Please pick another table.`, 'TABLE_UNAVAILABLE');
  return t;
}

async function quote(token, body) {
  const r = await resolve(token); assertType(r, body.orderType);
  if (body.orderType === 'DINE_IN') await assertTableFree(r, body.tableId);
  const c = await priceCart(r, body.orderType, body.items);
  return { currency: r.ctx.business.currency, orderType: body.orderType, lines: c.lines, totals: { ...c.totals, totalCents: undefined } };
}

// ------------------------------------------------------------------ order views
const stageOf = (o) => {
  const items = o.items.filter((i) => !i.parentItemId && i.status !== 'CANCELLED');
  if (!items.length) return 'RECEIVED';
  if (items.every((i) => i.status === 'SERVED')) return 'COMPLETED';
  if (items.every((i) => ['READY', 'SERVED'].includes(i.status))) return 'READY';
  if (items.some((i) => ['PREPARING', 'READY', 'SERVED'].includes(i.status))) return 'PREPARING';
  return 'RECEIVED';
};
function view(o, extra = {}) {
  const st = o.selfService?.paymentState; const paid = st === 'PAID';
  const stage = o.status === 'CANCELLED' || st === 'EXPIRED' ? 'CANCELLED' : paid ? stageOf(o) : st === 'AWAITING_CASH' ? 'AWAITING_CASHIER' : 'AWAITING_PAYMENT';
  const message = { AWAITING_CASHIER: 'Awaiting cashier payment confirmation. Take your bill to the cashier and pay.', AWAITING_PAYMENT: 'Waiting for payment.', CANCELLED: 'This order was cancelled and was not charged.', RECEIVED: 'Payment received. Your order was sent to the kitchen.', PREPARING: 'Your order is being prepared.', READY: o.orderType === 'DINE_IN' ? 'Your order is ready and is being served.' : 'Your order is ready for collection.', COMPLETED: 'Order completed. Enjoy!' }[stage];
  return {
    code: o.selfService?.publicCode, orderNumber: o.orderNumber, pickupNumber: o.pickupNumber, orderType: o.orderType, table: o.tableName,
    paymentMethod: o.selfService?.paymentMethod, paymentState: st, paid, paymentVerified: paid, stage, message, createdAt: o.createdAt, expiresAt: st && UNPAID.includes(st) ? o.selfService.expiresAt : undefined,
    items: o.items.filter((i) => !i.parentItemId && i.status !== 'CANCELLED').map((i) => ({ name: [i.name, i.variantName && `(${i.variantName})`].filter(Boolean).join(' '), quantity: i.quantity, total: money(Math.round(i.unitPrice * i.quantity)), status: paid ? i.status : 'WAITING_PAYMENT' })),
    totals: { itemsTotal: money(o.totals.itemsTotal), serviceCharge: money(o.totals.serviceCharge), tax: money(o.totals.tax), total: money(o.totals.total) },
    ...extra,
  };
}

async function byCode(r, code) {
  const o = await RestaurantOrder.findOne({ businessId: r.businessId, branchId: r.branchId, source: 'KIOSK', 'selfService.publicCode': code });
  if (!o) throw ApiError.notFound('Order not found.', 'ORDER_NOT_FOUND');
  return o;
}
const openBill = (orderId) => RestaurantBill.findOne({ orderId, status: { $in: ['OPEN', 'PARTIAL'] } }).sort({ createdAt: -1 });
const anyBill = (orderId) => RestaurantBill.findOne({ orderId, status: { $ne: 'VOID' } }).sort({ createdAt: -1 });

// ------------------------------------------------------------------ printable bill / receipt (same doc shape the print queue already uses)
async function printDoc(order, bill) {
  const ctx = await H.getContext(order.businessId); const b = ctx.business; const rs = b.receiptSettings || {};
  const branch = await Branch.findById(order.branchId).select('name');
  const paid = order.selfService?.paymentState === 'PAID' && bill.status === 'PAID';
  const txn = paid ? await MpesaTransaction.findOne({ businessId: order.businessId, 'kioskPay.orderId': order._id, status: 'SUCCESS' }).select('mpesaReceiptNumber reference') : null;
  const when = new Date(paid ? bill.settledAt || Date.now() : order.createdAt).toLocaleString('en-KE', { timeZone: ctx.timeZone });
  return {
    paid, status: paid ? 'PAID' : 'UNPAID',
    business: { name: b.name, address: b.address, phone: b.phone, pin: b.kraPin || b.taxPin },
    title: paid ? 'Receipt' : 'Bill',
    banner: paid ? undefined : 'UNPAID — CASH PAYMENT REQUIRED',
    meta: [['Restaurant', b.name], ['Branch', branch && branch.name], ['Order', order.orderNumber], ['Collect no.', order.pickupNumber], [order.tableName ? 'Table' : 'Order type', order.tableName || 'Take away'], ['Date', when], ['Receipt', paid ? bill.receiptNumber : undefined], ['M-PESA', txn && txn.mpesaReceiptNumber], ['Payment status', paid ? 'PAID' : 'UNPAID']].filter((m) => m[1]),
    lines: bill.lines.filter((l) => !l.isComp).map((l) => ({ qty: l.quantity, name: [l.name, l.variantName && `(${l.variantName})`].filter(Boolean).join(' '), sub: l.modifiersText, total: money(l.total) })),
    totals: [['Items', fmtN(bill.itemsTotal)], bill.discount ? ['Discount', '-' + fmtN(bill.discount)] : null, bill.serviceCharge ? ['Service charge', fmtN(bill.serviceCharge)] : null, bill.tax ? ['VAT included', fmtN(bill.tax)] : null, [paid ? 'TOTAL' : 'AMOUNT DUE', fmtN(bill.total), true], paid ? ['Paid', fmtN(bill.paid)] : null].filter(Boolean),
    payments: paid ? bill.payments.filter((p) => p.kind === 'PAYMENT').map((p) => ({ label: p.method === 'MPESA' ? 'M-PESA' : p.method, value: fmtN(p.amount), sub: p.reference })) : [],
    footer: paid ? (rs.footerMessage || 'Thank you!') : 'Take this bill to the cashier and pay cash. Your order is sent to the kitchen after you pay.',
  };
}
/** Puts a copy on the cashier printer's queue. Returns true only if the job was really stored; a printer fault never touches the order or payment. */
async function queuePrintJob(order, bill) {
  try {
    const ctx = await H.getContext(order.businessId); const target = ctx.ops.route('CASHIER');
    if (!target) return 'NO_PRINTER';
    const doc = await printDoc(order, bill);
    await PrintJob.create({ businessId: order.businessId, branchId: order.branchId, target, kind: doc.paid ? 'RECEIPT' : 'BILL', title: `${doc.paid ? 'Receipt' : 'UNPAID bill'} ${order.orderNumber}`, doc, refId: bill._id });
    await RestaurantOrder.updateOne({ _id: order._id }, { $inc: { 'selfService.billPrints': 1 } });
    return true;
  } catch (e) { console.error('[self-service] could not queue print job:', e.message); return false; }
}

// ------------------------------------------------------------------ checkout
async function createOrder(token, body) {
  const r = await resolve(token); const { businessId, branchId, ctx, ss } = r;
  assertType(r, body.orderType);
  const method = body.paymentMethod;
  if (method === 'CASH' && !cashOn(r)) throw ApiError.badRequest('Cash payment is not available on this kiosk.', 'PAYMENT_METHOD_DISABLED');
  if (method === 'MPESA' && !(await mpesaAllowed(r))) throw ApiError.badRequest('M-PESA payment is not available on this kiosk.', 'PAYMENT_METHOD_DISABLED');
  if (method === 'MPESA' && !PHONE.test(String(body.phone || '').replace(/[\s-]/g, ''))) throw ApiError.badRequest('Enter a valid Safaricom number, for example 0712 345 678.', 'INVALID_PHONE');
  const limit = ctx.settings.guestOrdering || {};
  if (body.items.some((i) => i.quantity > (limit.maxQuantityPerItem || 20))) throw ApiError.badRequest('Please ask a member of staff for that many of one item.', 'QUANTITY_TOO_HIGH');

  // a double tap / retry with the same clientRef returns the SAME order: never a second order or charge
  const prev = await RestaurantOrder.findOne({ businessId, branchId, deviceId: 'kiosk', clientRef: body.clientRef });
  if (prev && prev.selfService?.publicCode) return { order: view(prev), replayed: true };

  const cart = await priceCart(r, body.orderType, body.items);
  if (body.orderType === 'DINE_IN') await assertTableFree(r, body.tableId);
  const actor = await H.guestActor(businessId); actor.name = 'Self-service kiosk';
  const code = H.rand(10, H.CODE_ALPHABET);
  let created;
  try {
    created = await orders.createOrder(businessId, actor, { branchId, orderType: body.orderType, tableId: body.orderType === 'DINE_IN' ? body.tableId : undefined, source: 'KIOSK', guestCount: 1, customerName: body.customerName, customerPhone: method === 'MPESA' ? body.phone : undefined, clientRef: body.clientRef, deviceId: 'kiosk', _guest: true });
  } catch (e) {
    if (e.code === 'TABLE_OCCUPIED' || e.code === 'TABLE_UNAVAILABLE') throw ApiError.conflict('That table was just taken. Please pick another table.', 'TABLE_UNAVAILABLE');
    throw e;
  }
  if (created.replayed && created.order.selfService?.publicCode) return { order: view(created.order), replayed: true };
  const orderId = created.order._id;
  try {
    const raw = body.items.map((i, k) => ({ menuItemId: i.menuItemId, quantity: i.quantity, variantId: i.variantId, modifiers: (i.modifiers || []).map((m) => ({ groupId: m.groupId, optionId: m.optionId, quantity: m.quantity })), comboPicks: i.comboPicks && i.comboPicks.length ? i.comboPicks : undefined, notes: i.notes, clientItemId: `ks-${code}-${k}` }));
    await orders.addItems(businessId, actor, orderId, { items: raw, sendNow: false });          // the server prices every line again from the live menu
    const rc = await H.getContext(businessId);
    const doc = await RestaurantOrder.findById(orderId);
    for (const i of doc.items) if (i.status === 'DRAFT') i.status = 'HELD';                         // billable, but NO kitchen ticket until payment is verified
    doc.selfService = { publicCode: code, paymentMethod: method, paymentState: method === 'CASH' ? 'AWAITING_CASH' : 'PENDING', expiresAt: new Date(Date.now() + (ss.expiryMinutes || 30) * 60000) };
    H.recalcOrder(doc, rc); H.touch(doc, actor._id, 'selfservice.created', `Held until payment is verified (${method})`);
    await doc.save();
    if (doc.totals.total !== cart.totals.totalCents) console.warn('[self-service] cart estimate differs from order total', doc.orderNumber, cart.totals.totalCents, doc.totals.total);
    await bills.generateBill(businessId, actor, orderId, {});
  } catch (e) {
    await RestaurantOrder.updateOne({ _id: orderId }, { $set: { 'selfService.paymentState': 'EXPIRED' } }).catch(() => {});
    await orders.cancelOrder(businessId, actor, orderId, { reason: 'Self-service checkout failed' }).catch(() => {});   // frees the table
    throw e;
  }
  let order = await RestaurantOrder.findById(orderId); const bill = await openBill(orderId);
  if (method === 'CASH') return { order: view(order), bill: await printDoc(order, bill), payment: { method: 'CASH', status: 'AWAITING_CASHIER', amount: money(bill.balance) } };
  let payment;
  try { payment = await startMpesa(r, order, bill, body.phone); } catch (e) { payment = { method: 'MPESA', status: 'FAILED', message: e.message, retry: true }; }   // the order stays; the customer can retry
  order = await RestaurantOrder.findById(orderId);
  return { order: view(order), payment };
}

async function startMpesa(r, order, bill, phone) {
  const { businessId } = r;
  const digits = String(phone || '').replace(/[\s-]/g, '');
  if (!PHONE.test(digits)) throw ApiError.badRequest('Enter a valid Safaricom number, for example 0712 345 678.', 'INVALID_PHONE');
  if (!(bill && bill.balance > 0)) throw ApiError.conflict('Nothing is owing on this order.', 'NOTHING_TO_PAY');
  const again = await MpesaTransaction.findOne({ businessId, 'kioskPay.orderId': order._id, status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 90000) } });
  if (again && again.amount === bill.balance) return { method: 'MPESA', status: 'PROCESSING', reference: again.reference, amount: money(again.amount), reused: true };
  const actor = await H.guestActor(businessId);
  const txn = await mpesa.initiateStk(businessId, order.branchId, actor, { phone: digits, amountCents: bill.balance, customerName: order.customerName || 'Kiosk customer' });
  await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { kioskPay: { orderId: order._id, billId: bill._id, tries: 0 } } });
  await RestaurantOrder.updateOne({ _id: order._id }, { $set: { 'selfService.paymentMethod': 'MPESA', 'selfService.paymentState': 'PENDING', 'selfService.expiresAt': new Date(Date.now() + (r.ss.expiryMinutes || 30) * 60000), customerPhone: digits } });
  return { method: 'MPESA', status: 'PROCESSING', reference: txn.reference, amount: money(bill.balance) };
}

function assertPayable(order) {
  if (order.status !== 'OPEN' || !UNPAID.includes(order.selfService?.paymentState)) throw ApiError.conflict(order.selfService?.paymentState === 'PAID' ? 'This order is already paid.' : 'This order can no longer be paid. Please start again.', 'ORDER_NOT_PAYABLE');
}
const liveStk = (order) => MpesaTransaction.findOne({ businessId: order.businessId, 'kioskPay.orderId': order._id, $or: [{ status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 3 * 60000) } }, { status: 'SUCCESS', 'kioskPay.settledAt': null }] });

/** Retry M-PESA (or switch to it from cash) on an unpaid order. Safe: same order, never a second order. */
async function payMpesa(token, code, { phone }) {
  const r = await resolve(token);
  if (!(await mpesaAllowed(r))) throw ApiError.badRequest('M-PESA payment is not available on this kiosk.', 'PAYMENT_METHOD_DISABLED');
  const order = await byCode(r, code); assertPayable(order);
  const bill = await openBill(order._id);
  return { order: view(order), payment: await startMpesa(r, order, bill, phone) };
}

/** Switch an unpaid order to cash: prints the unpaid bill. The kitchen sees nothing until a cashier confirms the money. */
async function payCash(token, code) {
  const r = await resolve(token);
  if (!cashOn(r)) throw ApiError.badRequest('Cash payment is not available on this kiosk.', 'PAYMENT_METHOD_DISABLED');
  const order = await byCode(r, code); assertPayable(order);
  if (await liveStk(order)) throw ApiError.conflict('A phone payment is still in progress. Please wait a moment.', 'PAYMENT_IN_PROGRESS');
  await RestaurantOrder.updateOne({ _id: order._id }, { $set: { 'selfService.paymentMethod': 'CASH', 'selfService.paymentState': 'AWAITING_CASH', 'selfService.expiresAt': new Date(Date.now() + (r.ss.expiryMinutes || 30) * 60000) } });
  const fresh = await RestaurantOrder.findById(order._id); const bill = await openBill(order._id);
  return { order: view(fresh), bill: await printDoc(fresh, bill), payment: { method: 'CASH', status: 'AWAITING_CASHIER', amount: money(bill.balance) } };
}

async function cancelByCustomer(token, code) {
  const r = await resolve(token, { allowDisabled: true });
  const order = await byCode(r, code); assertPayable(order);
  if (await liveStk(order)) throw ApiError.conflict('A phone payment is still in progress. Please wait a minute before cancelling.', 'PAYMENT_IN_PROGRESS');
  await expireOne(order, 'Cancelled by the customer at the kiosk');
  return { order: view(await RestaurantOrder.findById(order._id)) };
}

/** Customer screen poll. The result shown comes from the SERVER's verified payment record, never from the browser. */
async function status(token, code) {
  const r = await resolve(token, { allowDisabled: true });
  let order = await byCode(r, code); let payment;
  if (order.selfService.paymentMethod === 'MPESA' || UNPAID.includes(order.selfService.paymentState)) {
    const txn = await MpesaTransaction.findOne({ businessId: r.businessId, 'kioskPay.orderId': order._id }).sort({ createdAt: -1 });
    if (txn) {
      let st = { status: txn.status, message: undefined, failureType: txn.failureType };
      if (txn.status === 'PENDING') { try { st = await mpesa.getStatus(r.businessId, txn.reference); } catch (e) { /* provider busy: next poll */ } }
      if (st.status === 'SUCCESS') await finalize(txn._id).catch((e) => console.error('[self-service] finalize failed', e.message));
      const f = `${st.failureType || ''} ${st.message || ''}`.toLowerCase();
      payment = { method: 'MPESA', reference: txn.reference, amount: money(txn.amount), mpesaReceipt: st.mpesaReceiptNumber || txn.mpesaReceiptNumber || null, message: st.message,
        status: st.status === 'SUCCESS' ? 'SUCCESS' : st.status === 'PENDING' ? 'PROCESSING' : /cancel/.test(f) ? 'CANCELLED' : /time|expire/.test(f) ? 'TIMEOUT' : 'FAILED' };
      order = await RestaurantOrder.findById(order._id);
      if (payment.status === 'SUCCESS' && order.selfService.paymentState !== 'PAID') payment.status = 'PROCESSING';   // paid at the provider, still being recorded: never show "paid" early
      payment.retry = ['FAILED', 'CANCELLED', 'TIMEOUT'].includes(payment.status) && UNPAID.includes(order.selfService.paymentState);
    }
  }
  return { order: view(order), payment };
}

async function billDoc(token, code) {
  const r = await resolve(token, { allowDisabled: true }); const order = await byCode(r, code);
  if (order.selfService.paymentState === 'EXPIRED') throw ApiError.conflict('This order was cancelled.', 'ORDER_CANCELLED');
  const bill = await anyBill(order._id); if (!bill) throw ApiError.notFound('No bill yet.', 'BILL_NOT_FOUND');
  return { bill: await printDoc(order, bill) };
}
async function queuePrint(token, code) {
  const r = await resolve(token, { allowDisabled: true }); const order = await byCode(r, code);
  if ((order.selfService.billPrints || 0) >= 5) throw ApiError.conflict('Please ask the cashier to reprint this for you.', 'PRINT_LIMIT');
  const bill = await anyBill(order._id); if (!bill) throw ApiError.notFound('No bill yet.', 'BILL_NOT_FOUND');
  const queued = await queuePrintJob(order, bill);
  if (queued === 'NO_PRINTER') return { queued: false, noPrinter: true, message: 'There is no printer here. Please note your order number and go to the cashier.' };
  if (!queued) throw ApiError.conflict('The printer is not available. Your order is safe; ask the cashier for a copy.', 'PRINT_FAILED');
  return { queued: true };
}

// ------------------------------------------------------------------ payment verified -> record once -> release once
/** Records a provider-CONFIRMED M-PESA payment against the bill, exactly once, however many places call it (callback, screen poll, sweep). */
async function finalize(txnId) {
  const stale = new Date(Date.now() - 60000);
  const txn = await MpesaTransaction.findOneAndUpdate(
    { _id: txnId, status: 'SUCCESS', 'kioskPay.orderId': { $ne: null }, 'kioskPay.settledAt': null, $or: [{ 'kioskPay.settleStartedAt': null }, { 'kioskPay.settleStartedAt': { $lt: stale } }] },
    { $set: { 'kioskPay.settleStartedAt': new Date() }, $inc: { 'kioskPay.tries': 1 } }, { new: true });
  if (!txn) { const t = await MpesaTransaction.findById(txnId); return { settled: !!(t && t.kioskPay && t.kioskPay.settledAt) }; }       // duplicate callback: nothing happens twice
  const businessId = txn.businessId; const g = txn.kioskPay;
  const problem = async (msg) => {
    await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { 'kioskPay.error': msg.slice(0, 200) } });
    if ((g.tries || 0) + 1 >= 3) H.notifyManagement(businessId, { type: 'KIOSK_PAYMENT_PROBLEM', title: 'A kiosk customer paid by M-PESA but the order was not completed', message: `${txn.mpesaReceiptNumber || txn.reference} (KSh ${txn.amount / 100}): ${msg}. Please check the order or refund the customer.`, entityType: 'MpesaTransaction', entityId: txn._id });
    return { settled: false, error: msg };
  };
  try {
    const order = await RestaurantOrder.findOne({ _id: g.orderId, businessId });
    if (!order || order.source !== 'KIOSK') return await problem('Order not found');
    if (!H.sameId(order.branchId, txn.branchId)) return await problem('Payment branch does not match the order');
    if (order.selfService.paymentState === 'PAID') { await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { 'kioskPay.settledAt': new Date() } }); return { settled: true, duplicate: true }; }
    if (order.status !== 'OPEN') return await problem(`Order is ${order.status.toLowerCase()} (payment arrived after it was cancelled)`);
    const bill = await RestaurantBill.findOne({ _id: g.billId, businessId, orderId: order._id });
    if (!bill) return await problem('Bill not found');
    if (txn.amount !== bill.balance && bill.status !== 'PAID') return await problem(`Amount mismatch: paid ${txn.amount / 100}, bill ${bill.balance / 100}`);
    if (!txn.restaurantBillId && bill.status !== 'PAID') await bills.pay(businessId, await H.guestActor(businessId), bill._id, { payments: [{ method: 'MPESA', amount: txn.amount, reference: txn.reference }] });   // consumeMpesa re-checks status, amount and single use
    await markPaid(order._id, 'MPESA');
    await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { 'kioskPay.settledAt': new Date() }, $unset: { 'kioskPay.error': 1 } });
    await release(businessId, order._id).catch((e) => console.error('[self-service] release failed, sweep will retry:', order.orderNumber, e.message));
    H.notifyRoles(businessId, order.branchId, [...H.CASHIER_ROLES, ...H.FLOOR_LEAD_ROLES], { type: 'KIOSK_ORDER_PAID', title: `Self-service ${order.orderNumber} paid`, message: `M-PESA ${txn.mpesaReceiptNumber || txn.reference} - sent to the kitchen.`, branchId: order.branchId, entityType: 'RestaurantOrder', entityId: order._id });
    return { settled: true };
  } catch (e) { console.error('[self-service] could not record payment', txn.reference, e.message); return problem(e.message || 'Could not record payment'); }
}
const finalizeByTxn = (id) => finalize(id).catch((e) => console.error('[self-service] finalize failed:', e.message));

/** Flips the order to PAID exactly once (atomic). Only called AFTER the bill payment was recorded. */
async function markPaid(orderId, method, by) {
  return RestaurantOrder.findOneAndUpdate({ _id: orderId, 'selfService.paymentState': { $in: UNPAID } },
    { $set: { 'selfService.paymentState': 'PAID', 'selfService.paymentMethod': method, 'selfService.paidAt': new Date(), ...(by ? { 'selfService.confirmedBy': by._id, 'selfService.confirmedByName': by.name } : {}) } }, { new: true });
}

/** Sends the held items to the existing kitchen/bar workflow ONCE. The atomic releasedAt claim stops duplicate tickets from duplicate callbacks, double clicks or the sweep. */
async function release(businessId, orderId) {
  const claimed = await RestaurantOrder.findOneAndUpdate({ _id: orderId, businessId, status: 'OPEN', 'selfService.paymentState': 'PAID', 'selfService.releasedAt': null }, { $set: { 'selfService.releasedAt': new Date() } });
  if (!claimed) return { released: false };
  try { await orders.fireCourse(businessId, await H.guestActor(businessId), orderId, { course: 1 }); return { released: true }; }
  catch (e) {
    if (e.code === 'NOTHING_TO_FIRE') return { released: false };
    await RestaurantOrder.updateOne({ _id: orderId }, { $unset: { 'selfService.releasedAt': 1 } });   // let the sweep try again
    throw e;
  }
}

// ------------------------------------------------------------------ cashier: confirm cash
/** The cashier took the money. Identity, permission and branch come from the login (route middleware + checks here); the kiosk can never call this. */
async function confirmCash(businessId, user, id, { tendered } = {}) {
  const order = await RestaurantOrder.findOne({ _id: id, businessId, source: 'KIOSK' });
  if (!order || !order.selfService) throw ApiError.notFound('Self-service order not found', 'ORDER_NOT_FOUND');
  H.assertBranchAccess(user, order.branchId);
  const st = order.selfService.paymentState;
  if (order.status === 'CANCELLED' || st === 'EXPIRED') throw ApiError.conflict('This order was cancelled or expired. Do not take payment for it.', 'ORDER_NOT_PAYABLE');
  if (st === 'PAID') { await release(businessId, order._id).catch(() => {}); return finishCash(order._id, true); }          // second click / retry: nothing is charged twice
  if (!UNPAID.includes(st)) throw ApiError.conflict('This order cannot take payment.', 'ORDER_NOT_PAYABLE');
  if (await liveStk(order)) throw ApiError.conflict('The customer has an M-PESA prompt in progress. Wait for it to finish before taking cash.', 'PAYMENT_IN_PROGRESS');
  const bill = await openBill(order._id);
  if (bill) {
    if (tendered != null && tendered < bill.balance) throw ApiError.badRequest('Cash received is less than the amount due.', 'TENDERED_TOO_LOW');
    await bills.pay(businessId, user, bill._id, { payments: [{ method: 'CASH', amount: bill.balance, tendered: tendered != null ? tendered : bill.balance }] });   // needs an open cash shift, like the till
  } else if (!(await RestaurantBill.exists({ orderId: order._id, status: 'PAID' }))) throw ApiError.conflict('There is no bill to pay on this order.', 'BILL_NOT_FOUND');
  await markPaid(order._id, 'CASH', user);
  let released = false;
  try { released = (await release(businessId, order._id)).released; } catch (e) { console.error('[self-service] release after cash failed, sweep will retry:', e.message); }
  return finishCash(order._id, false, released);
}
async function finishCash(orderId, already, released) {
  const order = await RestaurantOrder.findById(orderId); const bill = await anyBill(orderId);
  return { order: view(order), alreadyConfirmed: already || undefined, sentToKitchen: !!order.selfService.releasedAt, receipt: bill ? await printDoc(order, bill) : undefined };
}

// ------------------------------------------------------------------ staff screens
async function kioskLink(businessId, user) {
  const ctx = await H.getContext(businessId); const ss = ctx.settings.selfService || {};
  const fe = process.env.FRONTEND_URL && process.env.FRONTEND_URL !== '*' ? process.env.FRONTEND_URL.split(',')[0].trim() : '';
  const base = (ctx.settings.guestOrdering?.baseUrl || process.env.GUEST_APP_URL || fe || '').replace(/\/+$/, '');
  const token = makeToken(businessId, ss.kioskVersion || 1);
  return { enabled: !!ss.enabled, branchId: ss.branchId, configured: !!ss.branchId, token, url: `${base}/kiosk/${token}`, options: { dineIn: !!ss.dineIn, takeAway: !!ss.takeAway, mpesa: !!ss.mpesa, cash: !!ss.cash } };
}
async function rotateKiosk(businessId, user) {
  const ctx = await H.getContext(businessId);
  ctx.settings.selfService = { ...(ctx.settings.selfService && ctx.settings.selfService.toObject ? ctx.settings.selfService.toObject() : {}), kioskVersion: ((ctx.settings.selfService && ctx.settings.selfService.kioskVersion) || 1) + 1 };
  await ctx.settings.save();
  await H.audit({ businessId, userId: user._id, action: 'restaurant.selfservice.rotate', entityType: 'RestaurantSettings', entityId: ctx.settings._id });
  return kioskLink(businessId, user);
}

/** Cashier desk: self-service orders waiting for cash (default), or search by order number / collect number / table / customer code. */
async function staffList(businessId, user, { branchId, search, state } = {}) {
  const f = { businessId, source: 'KIOSK', ...H.branchFilter(H.branchScope(user, branchId)), createdAt: { $gt: new Date(Date.now() - 24 * 3600000) } };
  f['selfService.paymentState'] = state || { $in: UNPAID };
  if (search) { const rx = new RegExp(H.escapeRegex(search), 'i'); f.$or = [{ orderNumber: rx }, { pickupNumber: rx }, { tableName: rx }, { 'selfService.publicCode': String(search).toUpperCase() }]; }
  const rows = await RestaurantOrder.find(f).sort({ createdAt: 1 }).limit(100).select('orderNumber pickupNumber orderType tableName totals items.name items.quantity items.status selfService createdAt status');
  return {
    orders: rows.map((o) => ({ id: o._id, orderNumber: o.orderNumber, pickupNumber: o.pickupNumber, orderType: o.orderType, table: o.tableName, total: money(o.totals.total), itemCount: o.items.filter((i) => i.status !== 'CANCELLED').length, items: o.items.filter((i) => i.status !== 'CANCELLED').map((i) => `${i.quantity} x ${i.name}`),
      paymentMethod: o.selfService.paymentMethod, paymentState: o.selfService.paymentState, sentToKitchen: !!o.selfService.releasedAt, createdAt: o.createdAt, expiresAt: o.selfService.expiresAt })),
  };
}
async function staffReprint(businessId, user, id) {
  const order = await RestaurantOrder.findOne({ _id: id, businessId, source: 'KIOSK' });
  if (!order) throw ApiError.notFound('Self-service order not found', 'ORDER_NOT_FOUND');
  H.assertBranchAccess(user, order.branchId);
  const bill = await anyBill(order._id); if (!bill) throw ApiError.notFound('No bill yet.', 'BILL_NOT_FOUND');
  const queued = await queuePrintJob(order, bill);
  if (queued === 'NO_PRINTER') return { queued: false, noPrinter: true, doc: await printDoc(order, bill) };
  if (!queued) throw ApiError.conflict('Could not reach the print queue. Nothing was changed - try again.', 'PRINT_FAILED');
  return { queued: true, doc: await printDoc(order, bill) };
}

// ------------------------------------------------------------------ background safety nets
async function expireOne(order, reason) {
  const actor = await H.guestActor(order.businessId); actor.name = 'Self-service (auto)';
  await orders.cancelOrder(order.businessId, actor, order._id, { reason });
  await RestaurantOrder.updateOne({ _id: order._id }, { $set: { 'selfService.paymentState': 'EXPIRED' } });
}
/** Unpaid orders past their time are cancelled so tables are freed. Never touches an order whose M-PESA may still land. */
async function expireStale() {
  const due = await RestaurantOrder.find({ source: 'KIOSK', status: 'OPEN', 'selfService.paymentState': { $in: UNPAID }, 'selfService.expiresAt': { $lt: new Date() } }).limit(50);
  for (const o of due) {
    try {
      const inflight = await MpesaTransaction.exists({ businessId: o.businessId, 'kioskPay.orderId': o._id, $or: [{ status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 10 * 60000) } }, { status: 'SUCCESS', 'kioskPay.settledAt': null }] });
      if (inflight) continue;
      await expireOne(o, 'Self-service order expired unpaid');
    } catch (e) { console.error('[self-service] expiry failed', o.orderNumber, e.message); }
  }
}
/** Finishes M-PESA payments whose screen went away, polls STK pushes still waiting, and retries kitchen release that failed after payment was recorded. */
async function sweep() {
  const since = new Date(Date.now() - 3 * 3600000);
  const todo = await MpesaTransaction.find({ 'kioskPay.orderId': { $ne: null }, 'kioskPay.settledAt': null, createdAt: { $gt: since }, 'kioskPay.tries': { $lt: 6 }, status: { $in: ['SUCCESS', 'PENDING'] } }).limit(50);
  for (const t of todo) {
    try { if (t.status === 'PENDING') { if (Date.now() - t.createdAt.getTime() > 5 * 60000) continue; await mpesa.getStatus(t.businessId, t.reference); } await finalize(t._id); } catch (e) { /* next round */ }
  }
  const stuck = await RestaurantOrder.find({ source: 'KIOSK', status: 'OPEN', 'selfService.paymentState': 'PAID', 'selfService.releasedAt': null }).select('businessId').limit(50);
  for (const o of stuck) { try { await release(o.businessId, o._id); } catch (e) { /* next round */ } }
}

module.exports = { context, tables, menu, quote, createOrder, status, payMpesa, payCash, cancelByCustomer, billDoc, queuePrint, kioskLink, rotateKiosk, staffList, confirmCash, staffReprint, finalize, finalizeByTxn, release, sweep, expireStale, makeToken, parseToken };
