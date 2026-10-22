/**
 * The guest folio: every charge and payment of a stay. Room nights, fees and levies are posted by the stay service;
 * restaurant bills charged to the room are posted here; staff add minibar / laundry / extras; payments and deposits
 * are recorded here. The folio becomes ONE Sale (source ACCOMMODATION) at check-out.
 */
const Stay = require('../../models/Stay');
const Payment = require('../../models/Payment');
const Customer = require('../../models/Customer');
const CashShift = require('../../models/CashShift');
const ApiError = require('../../utils/ApiError');
const R = require('../../utils/hospitalityRates');
const H = require('../../constants/hospitality');
const { ensureSystemProduct } = require('../restaurant/systemProducts');
const { assertCountry } = require('../../middleware/requireCountry');
const mpesaService = require('../mpesa.service');
const C = require('./common');

const hist = (stay, action, by, note) => stay.history.push({ at: new Date(), action, by, note });

/** Recomputes every derived figure from the folio lines and payments. The ONLY place stay totals are calculated. */
function recompute(stay) {
  const paid = stay.payments.filter((p) => p.method !== 'CREDIT').reduce((s, p) => (p.kind === 'REFUND' ? s - p.amount : s + p.amount), 0);
  const credit = stay.payments.filter((p) => p.method === 'CREDIT' && p.kind !== 'REFUND').reduce((s, p) => s + p.amount, 0);
  const waived = stay.closeUnpaid?.amount || 0;
  const t = R.folioTotals(stay.folio, [], { credit, waived });
  stay.totals = { charges: t.charges, tax: t.tax, paid, credit, waived, balance: t.charges - paid - credit - waived };
  return stay.totals;
}

async function loadStay(businessId, id, session) {
  const s = await C.withSession(Stay.findOne({ _id: id, businessId }), session);
  if (!s) throw ApiError.notFound('Stay not found', 'STAY_NOT_FOUND');
  return s;
}

/** A stay that may take new charges (a bill charged to the room, a minibar line). */
async function assertChargeable(businessId, stayId, session) {
  if (!stayId) throw ApiError.badRequest('Choose the guest room to charge', 'STAY_REQUIRED');
  const s = await loadStay(businessId, stayId, session);
  if (s.status !== 'CHECKED_IN') throw ApiError.conflict(`Cannot charge a stay that is ${s.status.toLowerCase().replace('_', ' ')}`, 'STAY_NOT_CHECKED_IN');
  return s;
}

async function systemLine(businessId, type, session) {
  const sku = H.FOLIO_SKU[type] || H.FOLIO_SKU.OTHER;
  const name = { ROOM: 'Room accommodation', EARLY_CHECKIN: 'Early check-in', LATE_CHECKOUT: 'Late check-out', LEVY: 'Levy', MINIBAR: 'Minibar', LAUNDRY: 'Laundry', TRANSPORT: 'Transport', SERVICE: 'Service', DAMAGE: 'Damages', CANCELLATION: 'Cancellation fee', NO_SHOW: 'No-show charge', EXTRA_PERSON: 'Extra guest', FNB: 'Food and beverage', ADJUSTMENT: 'Adjustment', OTHER: 'Other charges' }[type] || 'Other charges';
  return ensureSystemProduct(businessId, sku, name, 0, session);
}

/** Builds a folio line from quantity x unit price in the business's tax mode. */
async function makeLine(ctx, businessId, { type, description, quantity = 1, unitPrice, taxRate, nightDate, source = 'MANUAL', userId, extra = {} }, session) {
  const p = await systemLine(businessId, type, session);
  const rate = taxRate ?? (type === 'LEVY' ? 0 : ctx.roomTaxRate);
  const a = R.folioLineAmounts(quantity, unitPrice, rate, ctx.taxInclusive);
  return { type, description, productId: p._id, sku: p.sku, quantity, unitPrice, taxRate: rate, ...a, cost: 0, nightDate, source, postedAt: new Date(), postedBy: userId, ...extra };
}

/** Voids the levy lines and posts fresh ones from the live ROOM lines (after nights were added, removed or repriced). */
async function rebuildLevies(stay, ctx, userId, session) {
  for (const l of stay.folio) if (l.type === 'LEVY' && !l.voided && l.source === 'AUTO') { l.voided = true; l.voidReason = 'Recalculated'; l.voidedAt = new Date(); }
  const rooms = stay.folio.filter((l) => !l.voided && ['ROOM', 'EXTRA_PERSON', 'EARLY_CHECKIN', 'LATE_CHECKOUT'].includes(l.type));
  const net = rooms.reduce((s, l) => s + (l.total - l.taxAmount), 0);
  for (const lv of R.levyAmounts(ctx.acc.tax?.levies, net, ctx.taxInclusive)) {
    stay.folio.push(await makeLine(ctx, stay.businessId, { type: 'LEVY', description: `${lv.name} (${(ctx.acc.tax.levies.find((x) => x.name === lv.name) || {}).percent}%)`, quantity: 1, unitPrice: lv.unitPrice, taxRate: lv.taxRate, source: 'AUTO', userId }, session));
  }
}

/** A restaurant bill charged to the room becomes folio lines (+ the bill's service charge). */
async function postBill({ bill, order, stayId, user, session, ctx }) {
  const stay = await assertChargeable(order.businessId, stayId, session);
  const prod = await systemLine(order.businessId, 'FNB', session);
  for (const l of bill.lines.filter((x) => !x.isComp)) {
    stay.folio.push({ type: 'FNB', description: [l.variantName ? `${l.name} (${l.variantName})` : l.name, l.modifiersText].filter(Boolean).join(' - '), productId: l.productId || prod._id, sku: l.sku || prod.sku, quantity: l.quantity, unitPrice: l.unitPrice,
      taxRate: l.taxRate, gross: l.gross, taxAmount: l.taxAmount, total: l.total, cost: l.cost, source: 'ORDER', orderId: order._id, billId: bill._id, billNumber: bill.billNumber, postedAt: new Date(), postedBy: user._id });
  }
  if (bill.serviceCharge > 0) stay.folio.push({ type: 'FNB', description: `Service charge ${bill.scPercent}% (${bill.billNumber})`, productId: prod._id, sku: prod.sku, quantity: 1, unitPrice: bill.serviceCharge, taxRate: bill.scTaxRate, gross: bill.serviceCharge, taxAmount: bill.serviceChargeTax, total: bill.serviceCharge, cost: 0, source: 'ORDER', orderId: order._id, billId: bill._id, billNumber: bill.billNumber, postedAt: new Date(), postedBy: user._id });
  recompute(stay); hist(stay, 'folio.bill_posted', user._id, `${bill.billNumber} ${order.orderNumber}`);
  stay.version += 1; await stay.save({ session });
  return stay;
}

async function addCharge(businessId, user, id, input) {
  C.requireCan(user, 'accommodation.folio.charge', 'Posting charges needs permission');
  return C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session);
    const stay = await assertChargeable(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (input.type === 'ADJUSTMENT' && input.unitPrice < 0) C.requireCan(user, 'accommodation.folio.adjust', 'Giving a discount needs a manager');
    stay.folio.push(await makeLine(ctx, businessId, { ...input, type: input.type, taxRate: input.taxRate, source: 'MANUAL', userId: user._id }, session));
    recompute(stay); hist(stay, 'folio.charge', user._id, `${input.type} ${input.description}`); stay.version += 1; await stay.save({ session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.folio.charge', entityType: 'Stay', entityId: stay._id, newValue: { type: input.type, description: input.description, amount: Math.round(input.quantity * input.unitPrice) } }, session);
    return stay;
  });
}

async function voidLine(businessId, user, id, lineId, { reason }) {
  C.requireCan(user, 'accommodation.folio.adjust', 'Removing a charge needs a manager');
  return C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session);
    const stay = await loadStay(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (!['RESERVED', 'CHECKED_IN'].includes(stay.status)) throw ApiError.conflict('This stay is already closed', 'STAY_CLOSED');
    const line = stay.folio.id(lineId); if (!line || line.voided) throw ApiError.notFound('Charge not found', 'FOLIO_LINE_NOT_FOUND');
    if (line.billId) throw ApiError.conflict('This charge came from a restaurant bill. Void or refund that bill instead.', 'LINE_FROM_BILL');
    line.voided = true; line.voidReason = reason; line.voidedBy = user._id; line.voidedAt = new Date();
    if (['ROOM', 'EXTRA_PERSON'].includes(line.type)) await rebuildLevies(stay, ctx, user._id, session);
    recompute(stay); hist(stay, 'folio.void', user._id, `${line.description}: ${reason}`); stay.version += 1; await stay.save({ session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.folio.void', entityType: 'Stay', entityId: stay._id, newValue: { line: line.description, total: line.total, reason } }, session);
    return stay;
  });
}

/**
 * Records ONE payment on a stay inside the caller's transaction: cash (needs an open shift), M-PESA (Kenya, verified),
 * mobile money (reference), card, bank, or customer credit. kind = DEPOSIT or PAYMENT.
 */
async function applyPayment({ businessId, stay, user, ctx, session, shift, kind = 'PAYMENT', payment: p, customerId }) {
  if (!(p.amount > 0)) throw ApiError.badRequest('Payment amount must be more than zero', 'INVALID_AMOUNT');
  const entry = { kind, method: p.method, amount: p.amount, reference: p.reference, at: new Date(), by: user._id };
  if (p.method === 'MOBILE_MONEY') Object.assign(entry, { network: p.network || 'OTHER', payerPhone: p.payerPhone, verifyStatus: 'PENDING' });
  if (p.method === 'CREDIT') {
    C.requireCan(user, 'accommodation.folio.credit', 'Putting a stay on credit needs permission');
    const cust = await Customer.findOne({ _id: customerId || stay.customerId, businessId, status: 'active' }).session(session);
    if (!cust) throw ApiError.badRequest('Attach a customer to put the stay on credit', 'CUSTOMER_REQUIRED_FOR_CREDIT');
    if (!ctx.business.settings?.enableCustomerCredit) throw ApiError.badRequest('Customer credit is not enabled for this business', 'CREDIT_DISABLED');
    if (!cust.creditLimit || cust.creditLimit <= 0) throw ApiError.badRequest('This customer has no credit limit set', 'NO_CREDIT_LIMIT');
    const pending = stay.payments.filter((x) => x.method === 'CREDIT').reduce((s, x) => s + x.amount, 0) + p.amount;
    if (cust.outstandingBalance + pending > cust.creditLimit) throw ApiError.badRequest('This would exceed the customer credit limit', 'CREDIT_LIMIT_EXCEEDED');
    stay.customerId = cust._id; stay.creditCustomerId = cust._id;
    stay.payments.push(entry); return null;
  }
  let provider = 'manual'; let ext; let meta; let verified = false;
  if (p.method === 'CASH' && ctx.settings.paymentsRequireShift && ctx.business.settings?.requireShift !== false && !shift) throw ApiError.badRequest('Open a cash shift before taking cash payments', 'SHIFT_REQUIRED');
  if (p.method === 'MOBILE_MONEY' && !p.reference) throw ApiError.badRequest('A mobile-money transaction reference is required', 'MOBILE_MONEY_REFERENCE_REQUIRED');
  if (p.method === 'MOBILE_MONEY') meta = { network: p.network || 'OTHER', payerPhone: p.payerPhone, verifyStatus: 'PENDING' };
  if (p.method === 'MPESA') {
    await assertCountry(businessId, 'KE');
    if (!p.reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED');
    const c = await mpesaService.consumeForRepair(businessId, p.reference, p.amount, stay._id, session, 'stayId');
    provider = c.channel === 'MANUAL' ? 'payhero-till' : 'payhero'; ext = c.externalTransactionId; meta = { checkoutRequestId: c.checkoutRequestId, channel: c.channel }; verified = true; entry.verifyStatus = 'VERIFIED';
  }
  const tendered = p.method === 'CASH' ? (p.tendered ?? p.amount) : undefined;
  if (p.method === 'CASH' && tendered < p.amount) throw ApiError.badRequest('Cash tendered is less than the amount', 'TENDERED_TOO_LOW');
  const [pay] = await Payment.create([{ businessId, branchId: stay.branchId, stayId: stay._id, customerId: stay.customerId, shiftId: shift?._id, method: p.method, provider, amount: p.amount, reference: p.reference, externalTransactionId: ext,
    metadata: { ...(meta || {}), kind, stayNumber: stay.stayNumber }, initiatedBy: user._id, status: 'SUCCESS', completedAt: new Date(), ...(p.method === 'CASH' ? { amountTendered: tendered, changeGiven: tendered - p.amount } : {}) }], { session });
  Object.assign(entry, { paymentId: pay._id, verified, ...(p.method === 'CASH' ? { tendered, change: tendered - p.amount } : {}) });
  stay.payments.push(entry);
  return pay;
}

const openShift = (businessId, branchId, userId, session) => CashShift.findOne({ businessId, branchId, cashierId: userId, status: 'OPEN' }).session(session);

/** Deposit or part-payment while the guest is staying (or before they arrive). */
async function addPayment(businessId, user, id, { kind = 'PAYMENT', ...p }) {
  C.requireCan(user, 'accommodation.folio.pay', 'Taking a payment needs permission');
  const out = await C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session);
    const stay = await loadStay(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (!['RESERVED', 'CHECKED_IN'].includes(stay.status)) throw ApiError.conflict('This stay is closed', 'STAY_CLOSED');
    recompute(stay);
    if (kind === 'PAYMENT' && p.method !== 'CREDIT' && p.amount > Math.max(0, stay.totals.balance) && stay.status === 'CHECKED_IN') throw ApiError.badRequest('Payment is more than the balance owing. Record the extra as a deposit.', 'OVERPAYMENT');
    const shift = await openShift(businessId, stay.branchId, user._id, session);
    const pay = await applyPayment({ businessId, stay, user, ctx, session, shift, kind, payment: p, customerId: p.customerId });
    recompute(stay); hist(stay, kind === 'DEPOSIT' ? 'folio.deposit' : 'folio.payment', user._id, `${p.method} ${p.amount}`); stay.version += 1; await stay.save({ session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.folio.payment', entityType: 'Stay', entityId: stay._id, newValue: { kind, method: p.method, amount: p.amount } }, session);
    return { stay, payment: pay };
  });
  if (kind === 'DEPOSIT') require('../storefront/storefront.service').onDeskPayment('STAY', out.stay, { method: p.method, amount: p.amount, reference: p.reference }).catch(() => {});     // online room booking: receipt + PAID in the customer's profile
  return out;
}

async function stayForPush(businessId, user, id) {
  C.requireCan(user, 'accommodation.folio.pay', 'Taking a payment needs permission');
  const stay = await loadStay(businessId, id); C.assertBranchAccess(user, stay.branchId);
  if (!['RESERVED', 'CHECKED_IN'].includes(stay.status)) throw ApiError.conflict('This stay is closed', 'STAY_CLOSED');
  recompute(stay); return stay;
}
async function mpesaStk(businessId, user, id, { phone, amountCents, customerName }) {
  const stay = await stayForPush(businessId, user, id);
  return mpesaService.initiateStk(businessId, stay.branchId, user, { phone, amountCents: amountCents || Math.max(0, stay.totals.balance), customerName: customerName || stay.guest?.name });
}
async function mpesaManual(businessId, user, id, { amountCents }) {
  const stay = await stayForPush(businessId, user, id);
  return mpesaService.initiateManual(businessId, stay.branchId, user, { amountCents: amountCents || Math.max(0, stay.totals.balance) });
}
const mpesaStatus = (businessId, reference) => mpesaService.getStatus(businessId, reference);
const mpesaClaim = (businessId, user, reference, receiptCode) => mpesaService.claimByCode(businessId, reference, user, receiptCode);
const mpesaCancel = (businessId, reference) => mpesaService.cancelManual(businessId, reference);
async function payContext(businessId, user, branchId) {
  C.assertBranchAccess(user, branchId);
  const ctx = await C.getAccContext(businessId);
  return require('../payContext.service').build({ businessId, branchId, user, ctx });
}
async function openCashShift(businessId, user, { branchId, registerId, openingCash }) {
  C.assertBranchAccess(user, branchId);
  return require('../payContext.service').openShift({ businessId, user, branchId, registerId, openingCash });
}

/** Money back to the guest (a deposit on cancellation, an overpayment) while the stay is still open. */
async function refund(businessId, user, id, { amount, method, reason }) {
  C.requireCan(user, 'accommodation.folio.refund', 'Refunds need a manager');
  return C.inTx(async (session) => {
    const stay = await loadStay(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (stay.status === 'CHECKED_OUT') throw ApiError.conflict('This stay is already invoiced', 'STAY_CLOSED');
    recompute(stay);
    if (amount > stay.totals.paid) throw ApiError.badRequest('Refund is more than was paid', 'REFUND_EXCEEDS_PAID');
    const shift = await openShift(businessId, stay.branchId, user._id, session);
    if (method === 'CASH' && !shift) throw ApiError.badRequest('Open a cash shift to pay cash out', 'SHIFT_REQUIRED');
    const [pay] = await Payment.create([{ businessId, branchId: stay.branchId, stayId: stay._id, shiftId: shift?._id, method, provider: 'manual', amount, status: 'REFUNDED', metadata: { kind: 'REFUND', reason }, initiatedBy: user._id, completedAt: new Date() }], { session });
    stay.payments.push({ kind: 'REFUND', method, amount, paymentId: pay._id, at: new Date(), by: user._id, note: reason });
    recompute(stay); hist(stay, 'folio.refund', user._id, reason); stay.version += 1; await stay.save({ session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.folio.refund', entityType: 'Stay', entityId: stay._id, newValue: { amount, method, reason } }, session);
    return stay;
  });
}

/**
 * Room-service order finished (every item served): bill it and charge it to the room, if the owner switched that on.
 * Never throws into the kitchen screen: a failure leaves the order open for the waiter to bill by hand.
 */
async function autoPostRoomOrder(businessId, orderId) {
  try {
    const RestaurantOrder = require('../../models/RestaurantOrder');
    const order = await RestaurantOrder.findOne({ _id: orderId, businessId });
    if (!order || order.orderType !== 'ROOM_SERVICE' || !order.stayId || order.status !== 'OPEN') return null;
    const ctx = await C.getAccContext(businessId);
    if (!ctx.features.accommodation || !ctx.acc.roomService.autoPostToFolio) return null;
    const live = order.items.filter((i) => !['CANCELLED', 'DRAFT'].includes(i.status) && !i.parentItemId);
    if (!live.length || !live.every((i) => i.status === 'SERVED')) return null;
    const bills = require('../restaurant/bill.service');
    const actor = await C.guestActor(businessId);
    const bill = await bills.generateBill(businessId, actor, order._id, {});
    return await bills.pay(businessId, actor, bill._id, { payments: [{ method: 'ROOM', amount: bill.balance, stayId: order.stayId }] });
  } catch (e) { console.error('[accommodation] auto-post of room order failed:', e.message); return null; }
}

module.exports = { mpesaStk, mpesaManual, mpesaStatus, mpesaClaim, mpesaCancel, payContext, openCashShift, autoPostRoomOrder, recompute, loadStay, assertChargeable, makeLine, systemLine, rebuildLevies, postBill, addCharge, voidLine, applyPayment, addPayment, refund, openShift, hist };
