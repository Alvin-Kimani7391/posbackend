/**
 * Bills, splits, payments, tips and settlement. A bill is created from an order's unbilled items; paying it in full creates the Sale
 * (source RESTAURANT) + Receipt + eTIMS entry in ONE transaction. Splitting carves exact integer slices (see utils/restaurantBilling).
 */
const mongoose = require('mongoose');
const RestaurantBill = require('../../models/RestaurantBill');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantTable = require('../../models/RestaurantTable');
const Reservation = require('../../models/Reservation');
const TipRecord = require('../../models/TipRecord');
const Sale = require('../../models/Sale');
const Receipt = require('../../models/Receipt');
const Payment = require('../../models/Payment');
const Refund = require('../../models/Refund');
const Customer = require('../../models/Customer');
const CustomerLedger = require('../../models/CustomerLedger');
const CashShift = require('../../models/CashShift');
const Branch = require('../../models/Branch');
const MpesaTransaction = require('../../models/MpesaTransaction');
const mpesaService = require('../mpesa.service');
const etimsService = require('../etims.service');
const notificationService = require('../notification.service');
const ApiError = require('../../utils/ApiError');
const { nextSequence, pad } = require('../../models/Counter');
const { ROLES } = require('../../constants/roles');
const { SERVICE_CHARGE_SKU } = require('../../constants/restaurant');
const B = require('../../utils/restaurantBilling');
const { ensureSystemProduct } = require('./systemProducts');
const consumption = require('./consumption.service');
const tables = require('./table.service');
const C = require('./common');
const { assertCountry } = require('../../middleware/requireCountry');
const { buildContext } = require('../../utils/businessContext');

const plainItem = (i) => i.toObject({ transform: false, virtuals: false });
const bErr = (e) => (e && e.code && !(e instanceof ApiError) && /^[A-Z_]+$/.test(e.code) ? ApiError.badRequest(e.message, e.code) : e);
const OPENISH = ['OPEN', 'PARTIAL'];

async function loadBill(businessId, id, session) {
  const b = await C.withSession(RestaurantBill.findOne({ _id: id, businessId }), session);
  if (!b) throw ApiError.notFound('Bill not found', 'BILL_NOT_FOUND');
  return b;
}
function assertBillAccess(user, bill) {
  C.assertBranchAccess(user, bill.branchId);
  if (!C.can(user, 'restaurant.orders.view_all') && !C.can(user, 'restaurant.bills.pay') && !C.sameId(bill.waiterId, user._id)) throw ApiError.forbidden('This bill belongs to another waiter', 'ORDER_NOT_YOURS');
}

/** Recomputes every derived figure from the lines + payments. The ONLY place bill totals are calculated. */
function recompute(bill) {
  const t = B.billTotals(bill.lines, { scPercent: bill.scPercent, scTaxRate: bill.scTaxRate, scWaived: bill.scWaived });
  Object.assign(bill, { gross: t.gross, discount: t.discount, itemsTotal: t.itemsTotal, serviceCharge: t.serviceCharge, serviceChargeTax: t.serviceChargeTax, tax: t.tax, total: t.total, cost: t.cost, compValue: t.compValue });
  bill.paid = bill.payments.reduce((s, p) => (p.method === 'CREDIT' ? s : s + (p.kind === 'REFUND' ? -p.amount : p.amount)), 0);
  bill.creditAmount = bill.payments.reduce((s, p) => (p.method === 'CREDIT' && p.kind !== 'REFUND' ? s + p.amount : s), 0);
  bill.balance = bill.status === 'PAID' || bill.status === 'WRITTEN_OFF' ? 0 : bill.total - bill.paid - bill.creditAmount - (bill.waived || 0);
}
const hist = (bill, action, by, note) => bill.history.push({ at: new Date(), action, by, note });

function orderBillStatus(bills) {
  const live = bills.filter((b) => b.status !== 'VOID');
  if (!live.length) return 'NONE';
  if (live.every((b) => ['PAID', 'WRITTEN_OFF'].includes(b.status))) return live.some((b) => b.status === 'WRITTEN_OFF') && live.every((b) => b.status === 'WRITTEN_OFF') ? 'WRITTEN_OFF' : 'PAID';
  if (live.some((b) => b.payments.length || ['PAID', 'WRITTEN_OFF'].includes(b.status))) return 'PARTIAL';
  return 'ISSUED';
}

async function newBill(order, ctx, user, session, { lines, label, parentBillId, customerId, splitMode }) {
  const seq = await nextSequence(order.businessId, `restbill:branch:${order.branchId}`, session);
  const sc = C.scConfig(ctx.settings, order.orderType);
  const [bill] = await RestaurantBill.create([{
    businessId: order.businessId, branchId: order.branchId, orderId: order._id, billNumber: `BL-${pad(seq, 5)}`, orderNumber: order.orderNumber, orderType: order.orderType, tableName: order.tableName,
    waiterId: order.waiterId, waiterName: order.waiterName, guestCount: order.guestCount, parentBillId, label, splitMode, taxInclusive: ctx.taxInclusive, lines, scPercent: sc.scPercent, scTaxRate: sc.scTaxRate,
    customerId: customerId || order.customerId, issuedBy: user._id, history: [{ at: new Date(), action: 'bill.issue', by: user._id }],
  }], { session });
  recompute(bill); await bill.save({ session });
  return bill;
}

// ------------------------------------------------------------------ generate
/** A guest who prepaid food when booking does not pay that part again: it comes off the bill the moment the bill is made. */
async function applyPrepaid(businessId, user, bill) {
  try {
    const order = await RestaurantOrder.findOne({ _id: bill.orderId, businessId }).select('reservationId');
    if (!order || !order.reservationId) return bill;
    const r = await Reservation.findOne({ _id: order.reservationId, businessId });
    if (!r || !r.deposit || !r.deposit.paid || r.deposit.refunded || r.deposit.forfeited) return bill;
    const left = (r.deposit.amount || 0) - (r.deposit.appliedAmount || 0); if (left <= 0) return bill;
    const fresh = await RestaurantBill.findById(bill._id); if (!fresh || !OPENISH.includes(fresh.status)) return bill;
    const amount = Math.min(left, fresh.balance); if (!(amount > 0)) return bill;
    await pay(businessId, user, bill._id, { payments: [{ method: 'DEPOSIT', amount, reservationId: r._id }] });
    return (await RestaurantBill.findById(bill._id)) || bill;
  } catch (e) { console.error('[restaurant] prepaid amount could not be applied:', e.message); return bill; }
}
async function generateBill(businessId, user, orderId, opts = {}) { return applyPrepaid(businessId, user, await generateBillCore(businessId, user, orderId, opts)); }
async function generateBillCore(businessId, user, orderId, { label, customerId } = {}) {
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, orderId, session);
    C.assertOrderAccess(user, order, { write: true }); C.assertOpen(order);
    const existing = await RestaurantBill.find({ orderId: order._id, status: { $ne: 'VOID' } }).session(session);
    const billed = new Map();
    for (const b of existing) for (const l of b.lines) billed.set(String(l.orderItemId), (billed.get(String(l.orderItemId)) || 0) + l.quantity);
    const lines = [];
    for (const it of order.items) {
      if (!B.isBillable(it)) continue;
      const left = B.round4(it.quantity - (billed.get(String(it._id)) || 0));
      if (left > 1e-9) lines.push(B.buildLine({ ...plainItem(it), quantity: left }, ctx.taxInclusive));
    }
    if (!lines.length) throw ApiError.conflict('Everything on this order is already on a bill', 'NOTHING_TO_BILL');
    let bill;
    const only = existing.length === 1 ? existing[0] : null;
    if (only && only.status === 'OPEN' && !only.payments.length && !only.splitMode && !only.parentBillId) {
      only.lines = B.mergeLines(only.lines, lines); recompute(only); hist(only, 'bill.refresh', user._id, `${lines.length} new line(s)`); await only.save({ session }); bill = only;
    } else bill = await newBill(order, ctx, user, session, { lines, label: label || (existing.length ? 'Additional' : undefined), customerId });
    const all = await RestaurantBill.find({ orderId: order._id }).session(session);
    order.billStatus = orderBillStatus(all); order.billRequestedAt = order.billRequestedAt || new Date();
    if (order.tableId) await RestaurantTable.updateOne({ _id: order.tableId, status: 'OCCUPIED' }, { $set: { status: 'AWAITING_BILL', statusSince: new Date() } }, { session });
    C.touch(order, user._id, 'bill.generate', bill.billNumber); await order.save({ session });
    await C.audit({ businessId, branchId: order.branchId, userId: user._id, action: 'restaurant.bill.generate', entityType: 'RestaurantBill', entityId: bill._id, newValue: { billNumber: bill.billNumber, total: bill.total } }, session);
    return bill;
  }).catch((e) => { throw bErr(e); });
}

/** An order item was cancelled / comped / reduced: keep the unpaid bills in step. Settled bills are never silently changed. */
async function adjustBillsForItem(order, item, { session, ctx, mode }) {
  const bills = await RestaurantBill.find({ orderId: order._id, status: { $in: ['OPEN', 'PARTIAL', 'PAID'] }, 'lines.orderItemId': item._id }).session(session);
  if (!bills.length) return;
  let excess = 0;
  if (mode === 'QUANTITY') excess = Math.max(0, B.round4(bills.reduce((s, b) => s + b.lines.filter((l) => C.sameId(l.orderItemId, item._id)).reduce((t, l) => t + l.quantity, 0), 0) - item.quantity));
  for (const bill of bills) {
    if (bill.status === 'PAID') throw ApiError.conflict('That item is on a bill that was already paid. Refund the bill instead.', 'BILL_SETTLED');
    if (mode === 'CANCEL') bill.lines = bill.lines.filter((l) => !C.sameId(l.orderItemId, item._id));
    else if (mode === 'REBUILD') bill.lines = bill.lines.map((l) => (C.sameId(l.orderItemId, item._id) ? B.buildLine({ ...plainItem(item), quantity: l.quantity }, bill.taxInclusive) : l.toObject({ transform: false })));
    else if (mode === 'QUANTITY' && excess > 0) {
      bill.lines = bill.lines.map((l) => {
        if (!C.sameId(l.orderItemId, item._id) || excess <= 0) return l.toObject({ transform: false });
        const cut = Math.min(excess, l.quantity); excess = B.round4(excess - cut);
        return B.carveLine(l, cut / l.quantity).parent;
      }).filter((l) => l.quantity > 1e-9 || l.total !== 0);
    }
    recompute(bill);
    if (bill.payments.length && bill.paid + bill.creditAmount > bill.total + (bill.waived || 0)) throw ApiError.conflict('That item is already paid for on a part-paid bill. Refund or adjust through a manager.', 'ITEM_ALREADY_PAID');
    if (!bill.lines.length && !bill.payments.length) { bill.status = 'VOID'; bill.voidReason = 'All items removed'; }
    hist(bill, 'bill.item_adjust', undefined, `${mode}: ${item.name}`);
    await bill.save({ session });
  }
  const all = await RestaurantBill.find({ orderId: order._id }).session(session);
  order.billStatus = orderBillStatus(all) === 'NONE' && order.billStatus === 'REQUESTED' ? 'REQUESTED' : orderBillStatus(all);
}

// ------------------------------------------------------------------ discounts / service charge
const roleLimit = (user, s) => {
  if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN) return 100;
  const d = s.discounts || {};
  return { MANAGER: d.managerMaxPercent, SUPERVISOR: d.supervisorMaxPercent, HEAD_WAITER: d.supervisorMaxPercent, CASHIER: d.cashierMaxPercent, WAITER: d.waiterMaxPercent }[user.role] ?? 0;
};

async function setDiscount(businessId, user, id, { type, value, reason }) {
  C.requireCan(user, 'restaurant.orders.discount', 'You cannot give discounts');
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const bill = await loadBill(businessId, id, session); assertBillAccess(user, bill);
    if (bill.status !== 'OPEN' || bill.payments.length) throw ApiError.conflict('Discounts can only be applied before any payment', 'BILL_NOT_EDITABLE');
    if (bill.discountInfo?.amount) throw ApiError.conflict('This bill already has a discount. Remove it first.', 'DISCOUNT_EXISTS');
    let r; try { r = B.applyDiscount(bill.lines, { type, value }, bill.taxInclusive); } catch (e) { throw bErr(e); }
    const limit = roleLimit(user, ctx.settings);
    if (r.percentOfBill > limit + 0.0001) throw ApiError.forbidden(`This discount is ${Math.round(r.percentOfBill * 10) / 10}% but your limit is ${limit}%. Ask a manager.`, 'DISCOUNT_LIMIT_EXCEEDED');
    bill.lines = r.lines; bill.discountInfo = { type, value, amount: r.applied, reason, approvedBy: user._id, at: new Date() };
    recompute(bill); hist(bill, 'bill.discount', user._id, reason); await bill.save({ session });
    await C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'restaurant.bill.discount', entityType: 'RestaurantBill', entityId: bill._id, newValue: { type, value, amount: r.applied, reason } }, session);
    return bill;
  });
}
async function removeDiscount(businessId, user, id) {
  C.requireCan(user, 'restaurant.orders.discount');
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const bill = await loadBill(businessId, id, session); assertBillAccess(user, bill);
    if (bill.status !== 'OPEN' || bill.payments.length) throw ApiError.conflict('The bill is not editable', 'BILL_NOT_EDITABLE');
    const order = await C.loadOrder(businessId, bill.orderId, session);
    bill.lines = bill.lines.map((l) => { const it = order.items.id(l.orderItemId); return it ? B.buildLine({ ...plainItem(it), quantity: l.quantity }, bill.taxInclusive) : l.toObject({ transform: false }); });
    bill.discountInfo = undefined; recompute(bill); hist(bill, 'bill.discount_removed', user._id); await bill.save({ session }); return bill;
  });
}
async function waiveServiceCharge(businessId, user, id, { waive, reason }) {
  C.requireCan(user, 'restaurant.bills.waive_service_charge', 'Only a manager can waive the service charge');
  const bill = await loadBill(businessId, id); assertBillAccess(user, bill);
  if (bill.status !== 'OPEN' || bill.payments.length) throw ApiError.conflict('The bill is not editable', 'BILL_NOT_EDITABLE');
  bill.scWaived = !!waive; bill.scWaivedBy = waive ? user._id : undefined; bill.scWaiveReason = waive ? reason : undefined;
  recompute(bill); hist(bill, waive ? 'bill.sc_waived' : 'bill.sc_restored', user._id, reason); await bill.save();
  await C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'restaurant.bill.service_charge', entityType: 'RestaurantBill', entityId: bill._id, newValue: { waive, reason } });
  return bill;
}

// ------------------------------------------------------------------ split / move / merge
async function splitBill(businessId, user, id, input) {
  C.requireCan(user, 'restaurant.bills.split', 'You cannot split bills');
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const bill = await loadBill(businessId, id, session); assertBillAccess(user, bill);
    if (bill.status !== 'OPEN' || bill.payments.length) throw ApiError.conflict('Only an unpaid bill can be split', 'BILL_NOT_EDITABLE');
    const order = await C.loadOrder(businessId, bill.orderId, session);
    let parts; let labels;
    try {
      if (input.mode === 'EQUAL') { parts = B.splitEqual(bill.lines, input.ways); labels = parts.map((_, i) => `Guest ${i + 1}`); }
      else if (input.mode === 'ITEMS') { const r = B.carveByQuantity(bill.lines, input.selections); parts = [r.remaining, r.taken]; labels = [bill.label, input.label || 'Split']; }
      else if (input.mode === 'AMOUNT') { const r = B.carveByAmount(bill.lines, input.amount); parts = [r.remaining, r.taken]; labels = [bill.label, input.label || 'Split']; }
      else if (input.mode === 'SEAT') { const m = B.groupBySeat(bill.lines); parts = [...m.values()]; labels = [...m.keys()].map((k) => (k ? `Seat ${k}` : 'Shared')); }
    } catch (e) { throw bErr(e); }
    parts = parts.map((p, i) => ({ lines: p, label: labels[i] })).filter((p) => p.lines.length);
    if (parts.length < 2) throw ApiError.badRequest('Nothing to split off. Choose items, an amount, or use a different split.', 'NOTHING_TO_SPLIT');
    const root = bill.parentBillId || bill._id;
    bill.lines = parts[0].lines; bill.label = parts[0].label; bill.splitMode = input.mode; bill.parentBillId = bill.parentBillId; recompute(bill); hist(bill, 'bill.split', user._id, input.mode); await bill.save({ session });
    const out = [bill];
    for (const p of parts.slice(1)) out.push(await newBill(order, ctx, user, session, { lines: p.lines, label: p.label, parentBillId: root, customerId: bill.customerId, splitMode: input.mode }));
    if (input.mode === 'EQUAL' || input.mode === 'SEAT') { /* first part keeps the original id */ }
    await C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'restaurant.bill.split', entityType: 'RestaurantBill', entityId: bill._id, newValue: { mode: input.mode, parts: out.map((b) => ({ n: b.billNumber, total: b.total })) } }, session);
    return out;
  });
}

async function moveItems(businessId, user, id, { toBillId, selections }) {
  C.requireCan(user, 'restaurant.bills.split');
  return C.inTx(async (session) => {
    const from = await loadBill(businessId, id, session); const to = await loadBill(businessId, toBillId, session);
    assertBillAccess(user, from);
    if (!C.sameId(from.orderId, to.orderId) || String(from._id) === String(to._id)) throw ApiError.badRequest('Choose another bill of the same order', 'INVALID_TARGET');
    for (const b of [from, to]) if (b.status !== 'OPEN' || b.payments.length) throw ApiError.conflict('Both bills must be unpaid', 'BILL_NOT_EDITABLE');
    let r; try { r = B.carveByQuantity(from.lines, selections); } catch (e) { throw bErr(e); }
    from.lines = r.remaining; to.lines = B.mergeLines(to.lines, r.taken);
    recompute(from); recompute(to);
    if (!from.lines.length) { from.status = 'VOID'; from.voidReason = `Items moved to ${to.billNumber}`; }
    hist(from, 'bill.items_moved', user._id, to.billNumber); hist(to, 'bill.items_received', user._id, from.billNumber);
    await from.save({ session }); await to.save({ session });
    await C.audit({ businessId, branchId: from.branchId, userId: user._id, action: 'restaurant.bill.move_items', entityType: 'RestaurantBill', entityId: from._id, newValue: { to: to.billNumber } }, session);
    return { from, to };
  });
}

async function mergeBills(businessId, user, { billIds }) {
  C.requireCan(user, 'restaurant.bills.split');
  return C.inTx(async (session) => {
    const list = []; for (const id of billIds) list.push(await loadBill(businessId, id, session));
    const [target, ...rest] = list;
    assertBillAccess(user, target);
    for (const b of list) { if (!C.sameId(b.orderId, target.orderId)) throw ApiError.badRequest('Bills belong to different orders', 'ORDER_MISMATCH'); if (b.status !== 'OPEN' || b.payments.length) throw ApiError.conflict('Only unpaid bills can be merged', 'BILL_NOT_EDITABLE'); }
    for (const b of rest) { target.lines = B.mergeLines(target.lines, b.lines); b.status = 'VOID'; b.voidReason = `Merged into ${target.billNumber}`; hist(b, 'bill.merged', user._id); await b.save({ session }); }
    target.splitMode = undefined; recompute(target); hist(target, 'bill.merge', user._id, rest.map((b) => b.billNumber).join(', ')); await target.save({ session });
    return target;
  });
}

async function voidBill(businessId, user, id, { reason }) {
  C.requireCan(user, 'restaurant.bills.generate');
  return C.inTx(async (session) => {
    const bill = await loadBill(businessId, id, session); assertBillAccess(user, bill);
    if (bill.status !== 'OPEN' || bill.payments.length) throw ApiError.conflict('Only an unpaid bill can be voided. Refund a paid one.', 'BILL_NOT_EDITABLE');
    bill.status = 'VOID'; bill.voidReason = reason; bill.voidedBy = user._id; hist(bill, 'bill.void', user._id, reason); await bill.save({ session });
    const order = await C.loadOrder(businessId, bill.orderId, session);
    order.billStatus = orderBillStatus(await RestaurantBill.find({ orderId: order._id }).session(session)); C.touch(order, user._id, 'bill.void', bill.billNumber); await order.save({ session });
    await C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'restaurant.bill.void', entityType: 'RestaurantBill', entityId: bill._id, newValue: { reason } }, session);
    return bill;
  });
}

// ------------------------------------------------------------------ M-PESA
/** Same checks as the till's consume functions, recorded against a restaurant bill. A code can be used once, by a sale, repair, job card OR bill. */
async function consumeMpesa(businessId, reference, expected, billId, session) {
  const txn = await MpesaTransaction.findOne({ businessId, reference }).session(session);
  if (!txn) throw ApiError.badRequest('M-PESA reference not recognized', 'MPESA_REFERENCE_NOT_FOUND');
  if (txn.status !== 'SUCCESS') throw ApiError.badRequest('This M-PESA payment has not been confirmed as successful yet', 'MPESA_NOT_CONFIRMED');
  if (txn.saleId || txn.repairJobId || txn.jobCardId || txn.layawayId || txn.restaurantBillId || txn.stayId) throw ApiError.conflict('This M-PESA payment has already been used', 'MPESA_ALREADY_CONSUMED');
  if (txn.amount !== expected) throw ApiError.badRequest('The M-PESA amount confirmed does not match this payment', 'MPESA_AMOUNT_MISMATCH');
  txn.restaurantBillId = billId; await txn.save({ session });
  return { externalTransactionId: txn.mpesaReceiptNumber, checkoutRequestId: txn.checkoutRequestId, channel: txn.channel || 'STK' };
}
async function mpesaStk(businessId, user, id, { phone, amountCents, customerName }) {
  const bill = await loadBill(businessId, id); assertBillAccess(user, bill);
  if (!OPENISH.includes(bill.status)) throw ApiError.conflict('This bill cannot take payment', 'BILL_NOT_PAYABLE');
  if (amountCents > bill.balance) throw ApiError.badRequest('Amount is more than the balance', 'OVERPAYMENT');
  return mpesaService.initiateStk(businessId, bill.branchId, user, { phone, amountCents: amountCents || bill.balance, customerName });
}
async function mpesaManual(businessId, user, id, { amountCents }) {
  const bill = await loadBill(businessId, id); assertBillAccess(user, bill);
  return mpesaService.initiateManual(businessId, bill.branchId, user, { amountCents: amountCents || bill.balance });
}
const mpesaStatus = (businessId, reference) => mpesaService.getStatus(businessId, reference);
async function payContext(businessId, user, branchId) {
  C.assertBranchAccess(user, branchId);
  const ctx = await C.getContext(businessId);
  return require('../payContext.service').build({ businessId, branchId, user, ctx });
}
async function openShift(businessId, user, { branchId, registerId, openingCash }) {
  C.assertBranchAccess(user, branchId);
  return require('../payContext.service').openShift({ businessId, user, branchId, registerId, openingCash });
}
const mpesaClaim = (businessId, user, reference, receiptCode) => mpesaService.claimByCode(businessId, reference, user, receiptCode);
const mpesaCancel = (businessId, reference) => mpesaService.cancelManual(businessId, reference);

// ------------------------------------------------------------------ payment
async function pay(businessId, user, id, { payments, customerId }) {
  const out = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const bill = await loadBill(businessId, id, session); assertBillAccess(user, bill);
    if (!OPENISH.includes(bill.status)) throw ApiError.conflict(`Bill is ${bill.status}`, 'BILL_NOT_PAYABLE');
    recompute(bill);
    if (customerId) { const c = await Customer.findOne({ _id: customerId, businessId, status: 'active' }).session(session); if (!c) throw ApiError.badRequest('Customer not found', 'INVALID_CUSTOMER'); bill.customerId = c._id; }
    const shift = await CashShift.findOne({ businessId, branchId: bill.branchId, cashierId: user._id, status: 'OPEN' }).session(session);
    if (payments.some((p) => p.method === 'CASH') && ctx.settings.paymentsRequireShift && ctx.business.settings?.requireShift !== false && !shift) throw ApiError.badRequest('Open a cash shift before taking cash payments', 'SHIFT_REQUIRED');
    const order = await C.loadOrder(businessId, bill.orderId, session);
    let balance = bill.balance; const docs = []; let roomStay = null;
    for (const p of payments) {
      if (!(p.amount > 0)) throw ApiError.badRequest('Payment amount must be more than zero', 'INVALID_AMOUNT');
      if (p.amount > balance) throw ApiError.badRequest('Payment is more than the balance owing', 'OVERPAYMENT');
      const entry = { kind: 'PAYMENT', method: p.method, amount: p.amount, reference: p.reference, at: new Date(), by: user._id };
      if (p.method === 'MOBILE_MONEY') Object.assign(entry, { network: p.network || 'OTHER', payerPhone: p.payerPhone, verifyStatus: 'PENDING' });
      if (p.method === 'CREDIT') {
        C.requireCan(user, 'restaurant.bills.credit', 'Putting a bill on credit needs permission');
        const cust = bill.customerId ? await Customer.findOne({ _id: bill.customerId, businessId, status: 'active' }).session(session) : null;
        if (!cust) throw ApiError.badRequest('Attach a customer to put the bill on credit', 'CUSTOMER_REQUIRED_FOR_CREDIT');
        if (!ctx.business.settings?.enableCustomerCredit) throw ApiError.badRequest('Customer credit is not enabled for this business', 'CREDIT_DISABLED');
        if (!cust.creditLimit || cust.creditLimit <= 0) throw ApiError.badRequest('This customer has no credit limit set', 'NO_CREDIT_LIMIT');
        const pending = bill.creditAmount + p.amount;
        if (cust.outstandingBalance + pending > cust.creditLimit) throw ApiError.badRequest('This would exceed the customer credit limit', 'CREDIT_LIMIT_EXCEEDED');
      } else if (p.method === 'ROOM') {
        // Charge the WHOLE bill to a checked-in guest's room. No Sale yet: it is invoiced on the stay's check-out invoice.
        C.requireCan(user, 'accommodation.folio.charge', 'Charging a bill to a room needs permission');
        if (payments.length !== 1 || bill.payments.some((x) => x.kind === 'PAYMENT') || p.amount !== bill.balance) throw ApiError.badRequest('A room charge must cover the whole bill on its own', 'ROOM_CHARGE_FULL_BALANCE');
        roomStay = await require('../hospitality/folio.service').assertChargeable(businessId, p.stayId || order.stayId, session);
        entry.stayId = roomStay._id; entry.reference = roomStay.stayNumber; entry.verified = true;
      } else if (p.method === 'DEPOSIT') {
        const r = await Reservation.findOne({ _id: p.reservationId, businessId }).session(session);
        const left = r ? (r.deposit?.amount || 0) - (r.deposit?.appliedAmount || 0) : 0;
        if (!r || !r.deposit?.paid || left <= 0 || r.deposit.refunded || r.deposit.forfeited) throw ApiError.badRequest('No unused prepaid amount on that reservation', 'DEPOSIT_NOT_AVAILABLE');
        if (p.amount > left) throw ApiError.badRequest('More than the prepaid amount left', 'DEPOSIT_EXCEEDED');
        r.deposit.appliedAmount = (r.deposit.appliedAmount || 0) + p.amount; if (r.deposit.appliedAmount >= r.deposit.amount) r.deposit.appliedBillId = bill._id;
        await r.save({ session });
        entry.reservationId = r._id; entry.paymentId = r.deposit.paymentId; entry.verified = true;
      } else {
        let provider = 'manual'; let ext; let meta; let verified = false;
        if (p.method === 'MOBILE_MONEY' && !p.reference) throw ApiError.badRequest('A mobile-money transaction reference is required', 'MOBILE_MONEY_REFERENCE_REQUIRED');
        if (p.method === 'MOBILE_MONEY') meta = { network: p.network || 'OTHER', payerPhone: p.payerPhone, verifyStatus: 'PENDING' };
        if (p.method === 'MPESA') {
          await assertCountry(businessId, 'KE');                                  // automatic M-PESA verification (PayHero) is Kenya-only
          if (!p.reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED');
          const c = await consumeMpesa(businessId, p.reference, p.amount, bill._id, session);
          provider = c.channel === 'MANUAL' ? 'payhero-till' : 'payhero'; ext = c.externalTransactionId; meta = { checkoutRequestId: c.checkoutRequestId, channel: c.channel }; verified = true; entry.verifyStatus = 'VERIFIED';
        }
        const tendered = p.method === 'CASH' ? (p.tendered ?? p.amount) : undefined;
        if (p.method === 'CASH' && tendered < p.amount) throw ApiError.badRequest('Cash tendered is less than the amount', 'TENDERED_TOO_LOW');
        const [pay] = await Payment.create([{ businessId, branchId: bill.branchId, restaurantBillId: bill._id, customerId: bill.customerId, shiftId: shift?._id, method: p.method, provider, amount: p.amount, reference: p.reference, externalTransactionId: ext, metadata: meta, initiatedBy: user._id, status: 'SUCCESS', completedAt: new Date(), ...(p.method === 'CASH' ? { amountTendered: tendered, changeGiven: tendered - p.amount } : {}) }], { session });
        Object.assign(entry, { paymentId: pay._id, verified, ...(p.method === 'CASH' ? { tendered, change: tendered - p.amount } : {}) }); docs.push(pay);
      }
      bill.payments.push(entry); balance -= p.amount;
    }
    if (bill.status === 'OPEN') bill.status = 'PARTIAL';
    recompute(bill); hist(bill, 'bill.payment', user._id, payments.map((p) => `${p.method} ${p.amount}`).join(', '));
    if (order.tableId) await RestaurantTable.updateOne({ _id: order.tableId, status: { $in: ['OCCUPIED', 'AWAITING_BILL'] } }, { $set: { status: 'PAYMENT_PENDING', statusSince: new Date() } }, { session });
    let settled = null;
    if (bill.balance === 0) settled = await settle({ bill, order, ctx, user, session, shift });
    else await bill.save({ session });
    const all = await RestaurantBill.find({ orderId: order._id }).session(session);
    order.billStatus = orderBillStatus(all); C.touch(order, user._id, 'bill.payment', bill.billNumber); await order.save({ session });
    if (settled) await closeIfDone(order, all, ctx, user, session);
    return { bill, sale: settled?.sale, receipt: settled?.receipt, change: payments.some((p) => p.method === 'CASH') ? docs.filter((d) => d.method === 'CASH').reduce((s, d) => s + (d.changeGiven || 0), 0) : 0 };
  }).catch((e) => { throw bErr(e); });
  afterSettle(businessId, out.sale, out.bill);
  if (user && user.isGuestActor) require('../cashier/cashier.service').onGuestBillPaid(businessId, out.bill).catch((e) => console.error('[cashier] receipt queue failed', e.message));   // QR / kiosk / online M-PESA: the receipt prints at the cashier by itself
  return out;
}

/** Writes the Sale, Receipt, ledger and eTIMS rows for a fully-covered bill. Runs inside the caller's transaction. */
async function settle({ bill, order, ctx, user, session, shift }) {
  const { business } = ctx;
  const roomPay = bill.payments.find((p) => p.method === 'ROOM' && p.kind === 'PAYMENT');
  if (roomPay) {                                                    // charged to a room: becomes folio lines, invoiced at check-out
    bill.status = 'PAID'; bill.settledAt = new Date(); bill.settledBy = user._id; bill.postedToStayId = roomPay.stayId; recompute(bill);
    await require('../hospitality/folio.service').postBill({ bill, order, stayId: roomPay.stayId, user, session, ctx });
    hist(bill, 'bill.posted_to_room', user._id, roomPay.reference); await bill.save({ session });
    await TipRecord.updateMany({ billId: bill._id }, { $set: { orderId: order._id } }, { session });
    return null;
  }
  const effective = bill.total - (bill.waived || 0);
  bill.status = bill.waived > 0 && bill.paid + bill.creditAmount === 0 ? 'WRITTEN_OFF' : 'PAID'; bill.settledAt = new Date(); bill.settledBy = user._id; recompute(bill);
  if (effective <= 0) { await bill.save({ session }); await TipRecord.updateMany({ billId: bill._id }, { $set: { orderId: order._id } }, { session }); return null; }   // nothing owed (all complimentary / written off): no revenue, no Sale
  if (effective !== bill.paid + bill.creditAmount) throw ApiError.conflict('The bill total and payments do not add up. Contact support before closing.', 'BILL_TOTALS_MISMATCH');
  const branch = await Branch.findById(bill.branchId).session(session);
  const lines = bill.lines.filter((l) => !l.isComp);
  const items = lines.map((l) => ({
    productId: l.productId, nameSnapshot: l.variantName ? `${l.name} (${l.variantName})` : l.name, skuSnapshot: l.sku, quantity: l.quantity, unitPrice: l.unitPrice, costPriceSnapshot: l.quantity ? Math.round(l.cost / l.quantity) : 0,
    discount: l.discount, taxRate: l.taxRate, taxAmount: l.taxAmount, total: l.total, refundedQuantity: 0, serialNumbers: [],
  }));
  if (bill.serviceCharge > 0) {
    const scp = await ensureSystemProduct(bill.businessId, SERVICE_CHARGE_SKU, 'Service charge', bill.scTaxRate, session);
    items.push({ productId: scp._id, nameSnapshot: 'Service charge', skuSnapshot: SERVICE_CHARGE_SKU, quantity: 1, unitPrice: bill.serviceCharge, costPriceSnapshot: 0, discount: 0, taxRate: bill.scTaxRate, taxAmount: bill.serviceChargeTax, total: bill.serviceCharge, refundedQuantity: 0, serialNumbers: [] });
  }
  const rSeq = await nextSequence(bill.businessId, `receipt:branch:${bill.branchId}`, session);
  const receiptNumber = `${business.receiptSettings?.receiptPrefix || 'RCT'}-${branch?.code || 'MAIN'}-${pad(rSeq)}`;
  const iSeq = await nextSequence(bill.businessId, `invoice:branch:${bill.branchId}`, session);
  const invoiceNumber = `${business.receiptSettings?.invoicePrefix || 'INV'}-${branch?.code || 'MAIN'}-${pad(iSeq)}`;
  const now = new Date();
  const paymentStatus = bill.creditAmount > 0 ? (bill.paid > 0 ? 'PARTIAL' : 'CREDIT') : 'PAID';
  const [sale] = await Sale.create([{
    businessId: bill.businessId, branchId: bill.branchId, receiptNumber, invoiceNumber, customerId: bill.customerId, cashierId: user._id, shiftId: shift?._id, items,
    subtotal: bill.gross + bill.serviceCharge, itemDiscount: bill.discount, cartDiscount: bill.waived || 0, tax: bill.tax, total: effective, amountPaid: bill.paid, balance: bill.creditAmount,
    paymentStatus, saleStatus: 'COMPLETED', source: 'RESTAURANT', restaurantBillId: bill._id, restaurantOrderId: order._id,
    notes: `${order.tableName ? `Table ${order.tableName} · ` : ''}${order.orderNumber} · ${bill.billNumber}${bill.waived ? ` (balance waived: ${bill.waiveReason})` : ''}`, soldAt: now,
  }], { session });
  const payIds = bill.payments.filter((p) => p.paymentId && p.kind === 'PAYMENT').map((p) => p.paymentId);
  await Payment.updateMany({ $or: [{ businessId: bill.businessId, restaurantBillId: bill._id, 'metadata.kind': { $ne: 'TIP' } }, { _id: { $in: payIds } }] }, { $set: { saleId: sale._id } }, { session });
  await TipRecord.updateMany({ billId: bill._id }, { $set: { saleId: sale._id } }, { session });
  if (bill.creditAmount > 0 && bill.customerId) {
    const cust = await Customer.findOne({ _id: bill.customerId, businessId: bill.businessId }).session(session);
    const nb = cust.outstandingBalance + bill.creditAmount;
    await CustomerLedger.create([{ businessId: bill.businessId, customerId: cust._id, transactionType: 'SALE_CREDIT', referenceType: 'Sale', referenceId: sale._id, debit: bill.creditAmount, credit: 0, balance: nb, createdBy: user._id }], { session });
    await Customer.updateOne({ _id: cust._id }, { $inc: { outstandingBalance: bill.creditAmount } }, { session });
    sale._creditNotify = { cust, nb };
  }
  const rs = business.receiptSettings || {};
  const [receipt] = await Receipt.create([{
    businessId: bill.businessId, branchId: bill.branchId, saleId: sale._id, receiptNumber, invoiceNumber, soldAt: now,
    receiptData: {
      locale: (() => { const c = buildContext(business); return { currency: c.currency, countryCode: c.countryCode, language: c.language, taxIdLabel: c.country.taxIdLabel[c.language] }; })(),
      business: { name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin || business.taxPin, vrn: business.vrn, footerMessage: rs.footerMessage, headerMessage: rs.headerMessage, logo: rs.showLogo ? business.logo : undefined, showKraPin: rs.showKraPin ?? true, showCashierName: rs.showCashierName ?? true, showMpesaReceiptCode: rs.showMpesaReceiptCode ?? true, customLines: [...(rs.customLines || []), `${order.tableName ? `Table ${order.tableName} · ` : ''}${order.orderNumber}`, ...(order.waiterName ? [`Served by ${order.waiterName}`] : [])], paperWidth: rs.paperWidth || '80mm' },
      branch: { name: branch?.name, phone: branch?.phone }, cashier: { name: user.name },
      customer: order.customerName ? { name: order.customerName, phone: order.customerPhone } : undefined,
      items: lines.map((l) => ({ name: [l.variantName ? `${l.name} (${l.variantName})` : l.name, l.modifiersText].filter(Boolean).join(' - '), sku: l.sku, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxRate: l.taxRate, taxAmount: l.taxAmount, total: l.total })).concat(bill.serviceCharge > 0 ? [{ name: `Service charge ${bill.scPercent}%`, sku: SERVICE_CHARGE_SKU, quantity: 1, unitPrice: bill.serviceCharge, discount: 0, taxRate: bill.scTaxRate, taxAmount: bill.serviceChargeTax, total: bill.serviceCharge }] : []),
      subtotal: bill.gross + bill.serviceCharge, itemDiscount: bill.discount, cartDiscount: bill.waived || 0, tax: bill.tax, total: effective,
      payments: bill.payments.filter((p) => p.kind === 'PAYMENT').map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
      amountTendered: bill.payments.filter((p) => p.method === 'CASH').reduce((s, p) => s + (p.tendered || 0), 0), changeGiven: bill.payments.filter((p) => p.method === 'CASH').reduce((s, p) => s + (p.change || 0), 0), balance: bill.creditAmount, paymentStatus,
    },
  }], { session });
  bill.saleId = sale._id; bill.receiptNumber = receiptNumber; hist(bill, 'bill.settled', user._id, receiptNumber); await bill.save({ session });
  await C.audit({ businessId: bill.businessId, branchId: bill.branchId, userId: user._id, action: 'sale.create', entityType: 'Sale', entityId: sale._id, newValue: { receiptNumber, total: effective, source: 'RESTAURANT', bill: bill.billNumber } }, session);
  await etimsService.enqueueForSale(bill.businessId, bill.branchId, sale._id, { session });
  return { sale, receipt };
}

/** After commit: CRM capture, eTIMS submit, credit notifications. Never throws. */
function afterSettle(businessId, sale, bill) {
  if (bill && bill.status === 'PAID') require('../storefront/storefront.service').onBillPaid(bill).catch((e) => console.error('[storefront receipt] failed', e.message));   // online orders paid in cash / at the till: the customer's profile gets the e-receipt
  if (bill && bill.status === 'PAID') require('../hospitality/guest-portal.service').saveBillCopies(bill).catch((e) => console.error('[guest receipt] copy failed', e.message));   // signed-in QR guests keep an e-receipt even when the cashier took the payment
  if (!sale) return;
  try { require('../crm.service').onSaleCompleted(businessId, sale._id); } catch (e) { console.error('[crm] capture hook failed', e.message); }
  try { etimsService.kickForSale(businessId, sale._id); } catch (e) { console.error('[etims] kick failed', e.message); }
}

/** Closes the order when it is fully billed, fully paid and the food/delivery is complete. Releases the table and runs ON_ORDER_CLOSE depletion. */
async function closeIfDone(order, billList, ctx, user, session) {
  if (order.status !== 'OPEN') return false;
  const live = billList.filter((b) => b.status !== 'VOID');
  const billed = new Map();
  for (const b of live) for (const l of b.lines) billed.set(String(l.orderItemId), (billed.get(String(l.orderItemId)) || 0) + l.quantity);
  const unbilled = order.items.some((i) => B.isBillable(i) && B.round4(i.quantity - (billed.get(String(i._id)) || 0)) > 1e-9);
  const billable = order.items.some((i) => B.isBillable(i));
  if (unbilled || (billable && !live.length) || live.some((b) => !['PAID', 'WRITTEN_OFF'].includes(b.status))) return false;
  const itemsLive = order.items.filter((i) => !['CANCELLED', 'DRAFT'].includes(i.status));
  let complete;
  if (order.orderType === 'DELIVERY') complete = order.delivery?.status === 'DELIVERED';
  else if (['PICKUP', 'TAKEAWAY'].includes(order.orderType)) complete = order.pickup?.status === 'COLLECTED' || itemsLive.every((i) => i.status === 'SERVED');
  else complete = itemsLive.every((i) => i.status === 'SERVED');
  if (!complete) return false;
  await consumption.depleteDue(order, 'ON_ORDER_CLOSE', { ctx, userId: user._id, session });
  order.status = 'CLOSED'; order.closedAt = new Date(); order.billStatus = orderBillStatus(billList);
  if (order.tableId) await tables.releaseTable({ businessId: order.businessId, tableId: order.tableId, settings: ctx.settings, session });
  if (order.reservationId) await Reservation.updateOne({ _id: order.reservationId }, { $set: { status: 'COMPLETED' } }, { session });
  C.touch(order, user._id, 'order.close'); await order.save({ session });
  return true;
}

async function tryCloseOrder(businessId, orderId, user) {
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const order = await C.loadOrder(businessId, orderId, session);
    const bl = await RestaurantBill.find({ orderId: order._id }).session(session);
    return closeIfDone(order, bl, ctx, user, session);
  });
}

// ------------------------------------------------------------------ close unpaid / tips / refund
async function closeBill(businessId, user, id, { reason }) {
  const out = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const bill = await loadBill(businessId, id, session); assertBillAccess(user, bill);
    if (!OPENISH.includes(bill.status)) throw ApiError.conflict(`Bill is ${bill.status}`, 'BILL_NOT_PAYABLE');
    recompute(bill);
    if (bill.balance > 0) {
      C.requireCan(user, 'restaurant.bills.close_unpaid', 'Closing a bill without full payment needs a manager');
      if (!reason || reason.trim().length < 3) throw ApiError.badRequest('A reason is required', 'REASON_REQUIRED');
      bill.waived = bill.balance; bill.waiveReason = reason; recompute(bill);
    }
    const order = await C.loadOrder(businessId, bill.orderId, session);
    const shift = await CashShift.findOne({ businessId, branchId: bill.branchId, cashierId: user._id, status: 'OPEN' }).session(session);
    const settled = await settle({ bill, order, ctx, user, session, shift });
    const all = await RestaurantBill.find({ orderId: order._id }).session(session);
    order.billStatus = orderBillStatus(all); C.touch(order, user._id, 'bill.close', bill.billNumber); await order.save({ session });
    await closeIfDone(order, all, ctx, user, session);
    await C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'restaurant.bill.close', entityType: 'RestaurantBill', entityId: bill._id, newValue: { waived: bill.waived, reason } }, session);
    return { bill, sale: settled?.sale, receipt: settled?.receipt, order };
  }).catch((e) => { throw bErr(e); });
  afterSettle(businessId, out.sale, out.bill);
  if (out.bill.waived > 0) C.notifyManagement(businessId, { type: 'RESTAURANT_VOID', title: `Bill closed unpaid: ${out.bill.billNumber}`, message: `${user.name} closed ${out.bill.billNumber} with ${(out.bill.waived / 100).toFixed(2)} unpaid: ${reason}`, branchId: out.bill.branchId, entityType: 'RestaurantBill', entityId: out.bill._id });
  return out;
}

async function addTip(businessId, user, id, { amount, method, reference, waiterId }) {
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    if (!ctx.settings.tips?.enabled) throw ApiError.badRequest('Tips are switched off', 'TIPS_DISABLED');
    const bill = await loadBill(businessId, id, session); assertBillAccess(user, bill);
    if (bill.status === 'VOID') throw ApiError.conflict('Bill is void', 'BILL_NOT_PAYABLE');
    const shift = await CashShift.findOne({ businessId, branchId: bill.branchId, cashierId: user._id, status: 'OPEN' }).session(session);
    if (method === 'CASH' && ctx.settings.paymentsRequireShift && !shift) throw ApiError.badRequest('Open a cash shift before taking cash', 'SHIFT_REQUIRED');
    let provider = 'manual'; let ext; let meta;
    if (method === 'MPESA') { if (!reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED'); const c = await consumeMpesa(businessId, reference, amount, bill._id, session); provider = c.channel === 'MANUAL' ? 'payhero-till' : 'payhero'; ext = c.externalTransactionId; meta = { checkoutRequestId: c.checkoutRequestId, channel: c.channel }; }
    const [pay] = await Payment.create([{ businessId, branchId: bill.branchId, restaurantBillId: bill._id, saleId: bill.saleId, shiftId: shift?._id, method, provider, amount, reference, externalTransactionId: ext, metadata: { ...(meta || {}), kind: 'TIP' }, initiatedBy: user._id, status: 'SUCCESS', completedAt: new Date(), ...(method === 'CASH' ? { amountTendered: amount, changeGiven: 0 } : {}) }], { session });
    const [tip] = await TipRecord.create([{ businessId, branchId: bill.branchId, billId: bill._id, orderId: bill.orderId, saleId: bill.saleId, waiterId: waiterId || bill.waiterId, amount, method, reference, paymentId: pay._id, shiftId: shift?._id, recordedBy: user._id }], { session });
    await C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'restaurant.tip.record', entityType: 'TipRecord', entityId: tip._id, newValue: { amount, method, bill: bill.billNumber } }, session);
    return tip;
  });
}

async function refundBill(businessId, user, id, { amount, method, reason }) {
  C.requireCan(user, 'restaurant.bills.refund', 'Only a manager can refund a restaurant bill');
  const out = await C.inTx(async (session) => {
    const bill = await loadBill(businessId, id, session); C.assertBranchAccess(user, bill.branchId);
    if (bill.postedToStayId) throw ApiError.conflict('This bill was charged to a guest room. Adjust the room folio (or refund the stay invoice) instead.', 'BILL_POSTED_TO_ROOM');
    if (bill.status !== 'PAID' || !bill.saleId) throw ApiError.conflict('Only a paid bill can be refunded. Void an unpaid bill instead.', 'BILL_NOT_REFUNDABLE');
    recompute(bill);
    if (amount > bill.paid) throw ApiError.badRequest('Refund is more than was paid', 'REFUND_EXCEEDS_PAID');
    const sale = await Sale.findOne({ _id: bill.saleId, businessId }).session(session);
    const weights = sale.items.map((i) => Math.max(0, i.total - Math.round((i.total / i.quantity) * i.refundedQuantity)));
    const shares = B.allocate(amount, weights);
    const rItems = []; sale.items.forEach((it, k) => {
      if (!shares[k]) return;
      const q = it.total > 0 ? Math.min(it.quantity - it.refundedQuantity, B.round4((it.quantity * shares[k]) / it.total)) : 0;
      it.refundedQuantity = B.round4(it.refundedQuantity + q);
      rItems.push({ productId: it.productId, nameSnapshot: it.nameSnapshot, quantity: Math.max(0.001, q), amount: shares[k], disposition: 'DISPOSE' });
    });
    const seq = await nextSequence(businessId, 'refund:business', session);
    const [refund] = await Refund.create([{ businessId, branchId: bill.branchId, saleId: sale._id, customerId: sale.customerId, refundNumber: `RFD-${pad(seq)}`, items: rItems, amount, reason, paymentMethod: method, status: 'COMPLETED', requestedBy: user._id, approvedBy: user._id }], { session });
    await Payment.create([{ businessId, branchId: bill.branchId, saleId: sale._id, restaurantBillId: bill._id, refundId: refund._id, customerId: sale.customerId, method, provider: 'manual', amount, status: 'REFUNDED', initiatedBy: user._id, completedAt: new Date() }], { session });
    bill.payments.push({ kind: 'REFUND', method, amount, reference: refund.refundNumber, by: user._id }); recompute(bill); hist(bill, 'bill.refund', user._id, reason); await bill.save({ session }); await sale.save({ session });
    await C.audit({ businessId, branchId: bill.branchId, userId: user._id, action: 'restaurant.bill.refund', entityType: 'RestaurantBill', entityId: bill._id, newValue: { amount, method, reason, refund: refund.refundNumber } }, session);
    return { bill, refund, sale };
  });
  C.notifyManagement(businessId, { type: 'REFUND_COMPLETED', title: `Refund ${out.refund.refundNumber}`, message: `${user.name} refunded ${(amount / 100).toFixed(2)} on ${out.bill.billNumber}: ${reason}`, branchId: out.bill.branchId, entityType: 'Refund', entityId: out.refund._id });
  return { bill: out.bill, refund: out.refund };
}

// ------------------------------------------------------------------ reads
async function listBills(businessId, user, { branchId, status, orderId, mine, search, page = 1, limit = 20 }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (status) f.status = status; else f.status = { $in: ['OPEN', 'PARTIAL'] };
  if (orderId) f.orderId = orderId;
  if (!C.can(user, 'restaurant.orders.view_all') && !C.can(user, 'restaurant.bills.pay')) f.waiterId = user._id; else if (mine) f.waiterId = user._id;
  if (search) { const rx = new RegExp(C.escapeRegex(search), 'i'); f.$or = [{ billNumber: rx }, { tableName: rx }, { orderNumber: rx }]; }
  const [items, total] = await Promise.all([RestaurantBill.find(f).select('-history').sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit), RestaurantBill.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}
async function getBill(businessId, user, id) {
  const bill = await loadBill(businessId, id); assertBillAccess(user, bill);
  const [sale, receipt, tips] = bill.saleId ? await Promise.all([Sale.findById(bill.saleId).select('receiptNumber invoiceNumber total paymentStatus soldAt'), Receipt.findOne({ saleId: bill.saleId }), TipRecord.find({ billId: bill._id })]) : [null, null, await TipRecord.find({ billId: bill._id })];
  return { bill, sale, receipt, tips };
}

module.exports = {
  generateBill, adjustBillsForItem, setDiscount, removeDiscount, waiveServiceCharge, splitBill, moveItems, mergeBills, voidBill, pay, closeBill, addTip, refundBill,
  consumeMpesa, mpesaStk, mpesaManual, mpesaStatus, mpesaClaim, mpesaCancel, payContext, openShift, listBills, getBill, tryCloseOrder, closeIfDone, recompute, orderBillStatus, roleLimit,
};
