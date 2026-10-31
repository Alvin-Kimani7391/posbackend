/** Quotations -> approved orders (stock reserved) -> invoiced in parts (partial fulfilment, backorders). Money = integer cents. */
const Quotation = require('../../models/Quotation');
const Business = require('../../models/Business');
const Customer = require('../../models/Customer');
const Project = require('../../models/Project');
const BranchInventory = require('../../models/BranchInventory');
const AuditLog = require('../../models/AuditLog');
const { nextSequence, pad } = require('../../models/Counter');
const { reserveStock, releaseReserved } = require('../inventory.service');
const saleSvc = require('../sale.service');
const depositSvc = require('./deposit.service');
const productSvc = require('./product.service');
const { computeLineItem, maxDiscountPercentForRole } = require('../sale-pricing.util');
const { hasPermission } = require('../../utils/permissionCheck');
const { assertBranchAccess } = require('../../utils/branchAccess');
const withTx = require('../../utils/withTx');
const { fromCents } = require('../../utils/money');
const { OPEN_ORDER } = require('../../constants/hardware');
const ApiError = require('../../utils/ApiError');

const DAY = 86400000;
const r3 = (n) => Math.round(n * 1000) / 1000;
const hist = (q, user, action, note) => q.history.push({ at: new Date(), by: user._id, action, note });

/** pure: how much of a line is still to be delivered */
const remaining = (l) => r3(l.quantity - (l.fulfilledQty || 0));
/** pure: status of an approved order from its lines */
function orderStatus(items) { const done = items.every((l) => remaining(l) <= 0); const any = items.some((l) => (l.fulfilledQty || 0) > 0); return done ? 'FULFILLED' : any ? 'PARTIALLY_FULFILLED' : 'APPROVED'; }
/** pure: line margin percent on its net total */
function marginPct(line) { const net = line.unitPrice * line.quantity - (line.discount || 0); return net > 0 ? ((net - line.costSnapshot * line.quantity) / net) * 100 : 0; }

async function buildLines(businessId, business, user, customerId, items, settings) {
  const taxInclusive = !!business.taxSettings?.taxInclusive; const maxPct = maxDiscountPercentForRole(user.role, business);
  const lines = []; const low = [];
  for (const [i, it] of items.entries()) {
    const r = await productSvc.resolveLinePrice(businessId, business, customerId, it);
    let unitPrice = r.unitPrice;
    if (it.unitPrice != null && it.unitPrice !== unitPrice) { if (!hasPermission(user, 'sales.price_override')) throw ApiError.forbidden('You are not allowed to change prices', 'PRICE_OVERRIDE_DENIED'); unitPrice = it.unitPrice; }
    const discount = it.discount || 0; const gross = Math.round(unitPrice * it.quantity);
    if (discount > gross) throw ApiError.badRequest(`Discount on ${r.product.name} is more than the line`, 'INVALID_DISCOUNT');
    if (maxPct < 100 && discount > Math.round((gross * maxPct) / 100) + 1) throw ApiError.forbidden(`Discount exceeds your limit of ${maxPct}%`, 'DISCOUNT_LIMIT_EXCEEDED');
    const c = computeLineItem({ unitPrice, quantity: it.quantity, discount, taxRate: r.product.taxRate || 0, taxInclusive });
    const cost = Math.round((r.variant ? r.variant.costPrice : r.product.costPrice) * r.unit.factor);
    const line = { productId: r.product._id, variantId: r.variant?._id, unitId: r.unit.id || undefined, unitName: r.unit.name, unitFactor: r.unit.factor, nameSnapshot: r.product.name, skuSnapshot: r.variant ? r.variant.sku : r.product.sku, quantity: it.quantity, unitPrice, costSnapshot: cost, discount, taxRate: r.product.taxRate || 0, lineTotal: c.lineTotal, fulfilledQty: 0, reservedBase: 0 };
    if (marginPct(line) < settings.lowMarginPercent) low.push(i);
    lines.push(line);
  }
  return { lines, low };
}
const totals = (lines) => ({ subtotal: lines.reduce((s, l) => s + Math.round(l.unitPrice * l.quantity), 0), discountTotal: lines.reduce((s, l) => s + (l.discount || 0), 0), total: lines.reduce((s, l) => s + l.lineTotal, 0) });

async function create(businessId, user, input) {
  assertBranchAccess(user, input.branchId);
  const [business, customer, settings] = await Promise.all([Business.findById(businessId), Customer.findOne({ _id: input.customerId, businessId, status: 'active' }), productSvc.getSettings(businessId)]);
  if (!customer) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  if (input.projectId && !(await Project.exists({ _id: input.projectId, businessId, customerId: customer._id }))) throw ApiError.badRequest('That project does not belong to this customer', 'PROJECT_MISMATCH');
  const { lines, low } = await buildLines(businessId, business, user, customer._id, input.items, settings);
  const q = new Quotation({ businessId, branchId: input.branchId, number: `QT-${pad(await nextSequence(businessId, 'hardware:quote'))}`, customerId: customer._id, projectId: input.projectId, customerPO: input.customerPO, reference: input.reference, validUntil: input.validUntil || new Date(Date.now() + settings.quoteValidityDays * DAY), items: lines, ...totals(lines), deliveryCharge: input.deliveryCharge || 0, deliveryAddress: input.deliveryAddress, notes: input.notes, terms: input.terms, reserve: input.reserve !== false && settings.reserveOnApproval, lowMarginLines: low, createdBy: user._id });
  hist(q, user, 'CREATED'); await q.save();
  await AuditLog.create({ businessId, branchId: q.branchId, userId: user._id, action: 'hardware.quote.create', entityType: 'Quotation', entityId: q._id, newValue: { number: q.number, total: q.total } });
  return q;
}
async function load(businessId, id) { const q = await Quotation.findOne({ _id: id, businessId }); if (!q) throw ApiError.notFound('Quotation not found'); return q; }

async function update(businessId, user, id, input) {
  const q = await load(businessId, id);
  if (!['DRAFT', 'SENT'].includes(q.status)) throw ApiError.conflict('Only a draft or sent quotation can be edited. Approved orders are locked.', 'NOT_EDITABLE');
  const [business, settings] = await Promise.all([Business.findById(businessId), productSvc.getSettings(businessId)]);
  if (input.items) { const { lines, low } = await buildLines(businessId, business, user, q.customerId, input.items, settings); q.items = lines; Object.assign(q, totals(lines)); q.lowMarginLines = low; }
  for (const k of ['customerPO', 'reference', 'validUntil', 'deliveryCharge', 'deliveryAddress', 'notes', 'terms', 'reserve']) if (input[k] !== undefined) q[k] = input[k];
  if (input.projectId !== undefined) { if (input.projectId && !(await Project.exists({ _id: input.projectId, businessId, customerId: q.customerId }))) throw ApiError.badRequest('That project does not belong to this customer', 'PROJECT_MISMATCH'); q.projectId = input.projectId || undefined; }
  if (q.status === 'SENT') q.status = 'DRAFT'; // an edited quotation must be sent again
  hist(q, user, 'EDITED'); await q.save(); return q;
}
async function send(businessId, user, id) {
  const q = await load(businessId, id); if (q.status !== 'DRAFT') throw ApiError.conflict('Only a draft can be sent', 'INVALID_STATE');
  if (q.validUntil < new Date()) throw ApiError.badRequest('This quotation is already past its validity date. Extend it first.', 'EXPIRED');
  q.status = 'SENT'; hist(q, user, 'SENT'); await q.save(); return q;
}

async function releaseLines(q, session) {
  for (const l of q.items) if (l.reservedBase > 0) { await releaseReserved({ businessId: q.businessId, branchId: q.branchId, productId: l.productId, variantId: l.variantId || null, quantity: l.reservedBase, session }); l.reservedBase = 0; }
}
/** Approve = it becomes an order. Reserves stock (all of it, or what is available when backorders are allowed). Prices are locked. */
async function approve(businessId, user, id, { allowBackorder = false } = {}) {
  const q = await load(businessId, id);
  if (!['DRAFT', 'SENT'].includes(q.status)) throw ApiError.conflict('This quotation was already decided', 'INVALID_STATE');
  if (q.validUntil < new Date()) throw ApiError.conflict('This quotation has expired. Extend it and approve again.', 'EXPIRED');
  const settings = await productSvc.getSettings(businessId); const backordered = [];
  await withTx(async (session) => {
    if (q.reserve) for (const [i, l] of q.items.entries()) {
      const base = r3(l.quantity * l.unitFactor);
      let take = base;
      if (allowBackorder) { const inv = await BranchInventory.findOne({ businessId, branchId: q.branchId, productId: l.productId, variantId: l.variantId || null }).session(session); take = Math.max(0, Math.min(base, r3((inv ? inv.quantity - (inv.reservedQuantity || 0) : 0)))); if (take < base) backordered.push({ line: i, name: l.nameSnapshot, short: r3(base - take) }); }
      if (take > 0) await reserveStock({ businessId, branchId: q.branchId, productId: l.productId, variantId: l.variantId || null, quantity: take, session });
      l.reservedBase = take;
    }
    q.status = 'APPROVED'; q.approvedBy = user._id; q.approvedAt = new Date(); q.priceLockedAt = new Date();
    q.reservedUntil = q.reserve ? new Date(Date.now() + settings.reservationDays * DAY) : undefined;
    hist(q, user, 'APPROVED', backordered.length ? `Backorder on ${backordered.length} line(s)` : undefined);
    await q.save({ session });
  });
  await AuditLog.create({ businessId, branchId: q.branchId, userId: user._id, action: 'hardware.quote.approve', entityType: 'Quotation', entityId: q._id, newValue: { number: q.number } });
  return { quotation: q, backordered };
}
async function reject(businessId, user, id, reason) {
  const q = await load(businessId, id); if (!['DRAFT', 'SENT'].includes(q.status)) throw ApiError.conflict('This quotation was already decided', 'INVALID_STATE');
  q.status = 'REJECTED'; q.rejectedReason = reason; hist(q, user, 'REJECTED', reason); await q.save(); return q;
}
async function cancel(businessId, user, id, reason) {
  const q = await load(businessId, id);
  if (q.status === 'FULFILLED' || ['REJECTED', 'EXPIRED', 'CANCELLED'].includes(q.status)) throw ApiError.conflict('This quotation is already closed', 'INVALID_STATE');
  await withTx(async (session) => { await releaseLines(q, session); q.status = 'CANCELLED'; q.rejectedReason = reason; hist(q, user, 'CANCELLED', reason); await q.save({ session }); });
  return q;
}
async function extend(businessId, user, id, days) {
  const q = await load(businessId, id); if (!['DRAFT', 'SENT', 'EXPIRED'].includes(q.status)) throw ApiError.conflict('Only an open or expired quotation can be extended', 'INVALID_STATE');
  q.validUntil = new Date(Math.max(Date.now(), q.validUntil.getTime()) + days * DAY); if (q.status === 'EXPIRED') q.status = 'DRAFT'; hist(q, user, 'EXTENDED', `${days} days`); await q.save(); return q;
}

/** Expired quotations are closed; reservations past their hold are released (the order itself stays). Safe to run often. */
async function expireDue(businessId, now = new Date()) {
  const f = businessId ? { businessId } : {};
  const e = await Quotation.updateMany({ ...f, status: { $in: ['DRAFT', 'SENT'] }, validUntil: { $lt: now } }, { $set: { status: 'EXPIRED' }, $push: { history: { at: now, action: 'EXPIRED' } } });
  let released = 0;
  const due = await Quotation.find({ ...f, status: { $in: OPEN_ORDER }, reservedUntil: { $lt: now }, 'items.reservedBase': { $gt: 0 } }).limit(200);
  for (const q of due) { try { await withTx(async (session) => { await releaseLines(q, session); q.reservedUntil = undefined; q.history.push({ at: now, action: 'RESERVATION_RELEASED' }); await q.save({ session }); }); released += 1; } catch (err) { console.error('release reservation failed', q.number, err.message); } }
  return { expired: e.modifiedCount || 0, reservationsReleased: released };
}

/** Invoice all or part of an approved order. Locked prices are kept unless a manager re-prices. */
async function convert(businessId, branchId, user, id, { lines, payments = [], dueDate, reprice = false, notes, deposits = [] }) {
  assertBranchAccess(user, branchId);
  const q = await load(businessId, id);
  if (!OPEN_ORDER.includes(q.status)) throw ApiError.conflict(q.status === 'FULFILLED' ? 'Everything on this order is already invoiced' : 'Approve the quotation first. Only an approved order can be invoiced.', 'INVALID_STATE');
  if (String(q.branchId) !== String(branchId)) throw ApiError.badRequest('This order belongs to another branch', 'BRANCH_MISMATCH');
  if (reprice && !hasPermission(user, 'hardware.quotes.reprice')) throw ApiError.forbidden('Only a manager can invoice at today\'s prices', 'REPRICE_DENIED');
  const want = (lines && lines.length ? lines : q.items.filter((l) => remaining(l) > 0).map((l) => ({ lineId: String(l._id), quantity: remaining(l) })));
  if (new Set(want.map((w) => String(w.lineId))).size !== want.length) throw ApiError.badRequest('A line appears twice', 'DUPLICATE_LINE');
  const pick = want.map((w) => { const l = q.items.id(w.lineId); if (!l) throw ApiError.badRequest('That line is not on this order', 'LINE_NOT_FOUND'); if (w.quantity > remaining(l) + 1e-9) throw ApiError.badRequest(`Only ${remaining(l)} ${l.unitName} of ${l.nameSnapshot} is left to invoice`, 'EXCEEDS_ORDER'); return { l, qty: w.quantity }; });
  // claim the quantities atomically so two cashiers cannot invoice the same goods twice
  const claimed = [];
  const undoClaims = async () => { for (const c of claimed) await Quotation.updateOne({ _id: q._id }, { $inc: { 'items.$[l].fulfilledQty': -c.qty } }, { arrayFilters: [{ 'l._id': c.l._id }] }); };
  for (const p of pick) {
    const r = await Quotation.updateOne({ _id: q._id, businessId }, { $inc: { 'items.$[l].fulfilledQty': p.qty } }, { arrayFilters: [{ 'l._id': p.l._id, 'l.fulfilledQty': { $lte: r3(p.l.quantity - p.qty) } }] });
    if (!r.modifiedCount) { await undoClaims(); throw ApiError.conflict('Another invoice just took part of this order. Reload and try again.', 'ORDER_CHANGED'); }
    claimed.push(p);
  }
  // free the reservation for these goods, then sell them (the sale takes the stock)
  const freed = []; let held = { taken: [], payments: [] };
  try {
    if (deposits.length) { held = await depositSvc.reserve(businessId, q.customerId, deposits); payments = [...payments, ...held.payments]; }
    await withTx(async (session) => { for (const p of pick) { const base = Math.min(p.l.reservedBase, r3(p.qty * p.l.unitFactor)); if (base > 0) { await releaseReserved({ businessId, branchId, productId: p.l.productId, variantId: p.l.variantId || null, quantity: base, session }); freed.push({ p, base }); } } });
    const items = pick.map((p) => ({ productId: String(p.l.productId), variantId: p.l.variantId ? String(p.l.variantId) : undefined, unitId: p.l.unitId ? String(p.l.unitId) : undefined, quantity: p.qty, discount: Math.round((p.l.discount || 0) * (p.qty / p.l.quantity)), overridePrice: reprice ? undefined : p.l.unitPrice }));
    const result = await saleSvc.createSale(businessId, branchId, user, { branchId, customerId: String(q.customerId), items, payments, dueDate, cartDiscount: 0, notes: notes || `Order ${q.number}${q.customerPO ? ` / PO ${q.customerPO}` : ''}` }, { trustedPrices: true });
    await depositSvc.commit(businessId, held.taken, result.sale._id);
    const fresh = await Quotation.findById(q._id);
    for (const f of freed) { const l = fresh.items.id(f.p.l._id); l.reservedBase = Math.max(0, r3(l.reservedBase - f.base)); }
    fresh.fulfilments.push({ saleId: result.sale._id, at: new Date(), total: result.sale.total, repriced: !!reprice, lines: pick.map((p) => ({ lineId: p.l._id, quantity: p.qty })) });
    fresh.status = orderStatus(fresh.items); hist(fresh, user, 'INVOICED', `${result.sale.invoiceNumber || result.sale._id}`);
    await fresh.save();
    await AuditLog.create({ businessId, branchId, userId: user._id, action: 'hardware.quote.convert', entityType: 'Quotation', entityId: q._id, newValue: { saleId: result.sale._id, repriced: !!reprice } });
    return { quotation: fresh, ...result, backorder: fresh.items.filter((l) => remaining(l) > 0).map((l) => ({ lineId: l._id, name: l.nameSnapshot, remaining: remaining(l), unit: l.unitName })) };
  } catch (err) {
    await undoClaims().catch(() => {});
    await depositSvc.release(businessId, held.taken);
    for (const f of freed) { try { await withTx((session) => reserveStock({ businessId, branchId, productId: f.p.l.productId, variantId: f.p.l.variantId || null, quantity: f.base, session })); } catch (e) { console.error('could not re-reserve after failed invoice', q.number, e.message); } }
    throw err;
  }
}

async function list(businessId, user, { status, customerId, projectId, branchId, from, to, search, page = 1, limit = 30 }) {
  await expireDue(businessId);
  const q = { businessId }; if (status) q.status = status; if (customerId) q.customerId = customerId; if (projectId) q.projectId = projectId; if (branchId) q.branchId = branchId;
  if (from || to) q.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (search) { const r = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); q.$or = [{ number: r }, { customerPO: r }, { reference: r }]; }
  const [rows, total] = await Promise.all([Quotation.find(q).select('-items -history').populate('customerId', 'name phone').populate('projectId', 'name code').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), Quotation.countDocuments(q)]);
  return { total, page, rows };
}
async function get(businessId, id) { await expireDue(businessId); const q = await Quotation.findOne({ _id: id, businessId }).populate('customerId', 'name phone email creditLimit outstandingBalance').populate('projectId', 'name code siteAddress'); if (!q) throw ApiError.notFound('Quotation not found'); return q; }

/** Open orders with goods still to deliver. */
async function backorders(businessId, { branchId }) {
  const rows = await Quotation.find({ businessId, status: { $in: OPEN_ORDER }, ...(branchId ? { branchId } : {}) }).populate('customerId', 'name').lean();
  const out = [];
  for (const q of rows) for (const l of q.items) { const rem = r3(l.quantity - (l.fulfilledQty || 0)); if (rem > 0) out.push({ orderId: q._id, number: q.number, customer: q.customerId?.name, customerPO: q.customerPO, productId: l.productId, name: l.nameSnapshot, unit: l.unitName, ordered: l.quantity, delivered: l.fulfilledQty || 0, backorder: rem, reserved: l.reservedBase > 0 }); }
  return { count: out.length, rows: out };
}

/** Printable pro forma invoice for a quotation / order. */
async function proforma(businessId, id) {
  const q = await get(businessId, id); const b = await Business.findById(businessId).select('name phone email address taxSettings currency');
  return { document: 'PRO FORMA INVOICE', number: q.number, status: q.status, issuedAt: q.createdAt, validUntil: q.validUntil, business: b ? { name: b.name, phone: b.phone, email: b.email, address: b.address } : {}, customer: q.customerId, project: q.projectId, customerPO: q.customerPO, reference: q.reference, items: q.items.map((l) => ({ name: l.nameSnapshot, sku: l.skuSnapshot, quantity: l.quantity, unit: l.unitName, unitPrice: fromCents(l.unitPrice), discount: fromCents(l.discount), total: fromCents(l.lineTotal), taxRate: l.taxRate })), subtotal: fromCents(q.subtotal), discount: fromCents(q.discountTotal), total: fromCents(q.total), deliveryCharge: fromCents(q.deliveryCharge), grandTotal: fromCents(q.total + q.deliveryCharge), terms: q.terms, notes: q.notes, note: 'This is not a tax invoice. A tax invoice is issued when the goods are invoiced.' };
}

module.exports = { remaining, orderStatus, marginPct, create, update, send, approve, reject, cancel, extend, expireDue, convert, list, get, backorders, proforma };
