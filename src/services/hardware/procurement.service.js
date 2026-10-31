/** Supplier quotations, price comparison, price-change alerts and landed costs (freight / offloading / handling). Money = integer cents. */
const mongoose = require('mongoose');
const SupplierQuote = require('../../models/SupplierQuote');
const LandedCost = require('../../models/LandedCost');
const Supplier = require('../../models/Supplier');
const Product = require('../../models/Product');
const Purchase = require('../../models/Purchase');
const HardwareProfile = require('../../models/HardwareProfile');
const Expense = require('../../models/Expense');
const AuditLog = require('../../models/AuditLog');
const { fromCents } = require('../../utils/money');
const { unallocated } = require('./transport-pricing');
const transport = require('./transport.service');
const ApiError = require('../../utils/ApiError');
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const DAY = 86400000; const money = (c) => fromCents(Math.round(c || 0));

// ---------- pure ----------
/** landed cost spread over purchase lines. lines: [{ key, baseQty, value }]. Returns per line extra cents (sums exactly to amount). */
function allocateLanded(lines, amount, by = 'VALUE') {
  const w = lines.map((l) => (by === 'QUANTITY' ? l.baseQty : l.value)); const tot = w.reduce((s, x) => s + x, 0);
  if (!(tot > 0)) return lines.map(() => 0);
  const out = w.map((x) => Math.floor((amount * x) / tot)); let rest = amount - out.reduce((s, x) => s + x, 0);
  for (let i = 0; rest > 0; i = (i + 1) % out.length, rest--) out[i] += 1; // leftover cents, so the total is exact
  return out;
}
const effectivePrice = (q) => Math.round(q.pricePerBase * (1 - (q.discountPercent || 0) / 100));

// ---------- quotes ----------
async function createQuote(businessId, user, input) {
  const [sup, prod] = await Promise.all([Supplier.exists({ _id: input.supplierId, businessId }), Product.findOne({ _id: input.productId, businessId }).select('name units unit')]);
  if (!sup) throw ApiError.badRequest('Supplier not found', 'SUPPLIER_NOT_FOUND'); if (!prod) throw ApiError.badRequest('Product not found', 'PRODUCT_NOT_FOUND');
  let factor = 1; let unitName = input.unitName || prod.unit;
  if (input.unitName && input.unitName.toLowerCase() !== String(prod.unit).toLowerCase()) { const u = (prod.units || []).find((x) => x.name.toLowerCase() === input.unitName.toLowerCase()); if (!u) throw ApiError.badRequest(`${prod.name} has no unit called ${input.unitName}`, 'UNIT_NOT_FOUND'); factor = u.factor; }
  const q = await SupplierQuote.create({ businessId, supplierId: input.supplierId, productId: input.productId, unitName, unitFactor: factor, unitPrice: input.unitPrice, pricePerBase: Math.round(input.unitPrice / factor), discountPercent: input.discountPercent, minQty: input.minQty, leadTimeDays: input.leadTimeDays, validUntil: input.validUntil, reference: input.reference, notes: input.notes, createdBy: user._id });
  await AuditLog.create({ businessId, userId: user._id, action: 'hardware.supplierquote.create', entityType: 'SupplierQuote', entityId: q._id }); return q;
}
async function listQuotes(businessId, { productId, supplierId, status, page = 1, limit = 50 }) {
  const q = { businessId }; if (productId) q.productId = productId; if (supplierId) q.supplierId = supplierId; if (status) q.status = status;
  const [rows, total] = await Promise.all([SupplierQuote.find(q).populate('supplierId', 'name').populate('productId', 'name sku').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), SupplierQuote.countDocuments(q)]);
  return { total, page, rows };
}
async function setQuoteStatus(businessId, user, id, status) {
  const q = await SupplierQuote.findOne({ _id: id, businessId }); if (!q) throw ApiError.notFound('Quote not found'); q.status = status; await q.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'hardware.supplierquote.status', entityType: 'SupplierQuote', entityId: q._id, newValue: { status } }); return q;
}
/** Cheapest comparable supplier for a product, with each supplier's price, lead time and delivery record. */
async function compare(businessId, { productId, includeAlternatives = true, qty }) {
  const prod = await Product.findOne({ _id: productId, businessId }).select('name unit'); if (!prod) throw ApiError.notFound('Product not found');
  let ids = [oid(productId)];
  if (includeAlternatives) { const p = await HardwareProfile.findOne({ businessId, productId }).select('alternativeIds').lean(); ids = [...ids, ...(p?.alternativeIds || []).map(oid)]; }
  const now = new Date();
  const quotes = await SupplierQuote.find({ businessId, productId: { $in: ids }, status: { $in: ['OPEN', 'ACCEPTED'] }, $or: [{ validUntil: null }, { validUntil: { $gte: now } }] }).populate('supplierId', 'name phone').populate('productId', 'name').lean();
  const last = await Purchase.aggregate([{ $match: { businessId: oid(businessId) } }, { $unwind: '$items' }, { $match: { 'items.productId': { $in: ids } } }, { $sort: { purchaseDate: -1 } }, { $group: { _id: { s: '$supplierId', p: '$items.productId' }, perBase: { $first: { $divide: ['$items.unitCost', { $ifNull: ['$items.unitFactor', 1] }] } }, at: { $first: '$purchaseDate' } } }]);
  const L = new Map(last.map((x) => [`${x._id.s}:${x._id.p}`, x]));
  const stats = await Purchase.aggregate([{ $match: { businessId: oid(businessId) } }, { $unwind: '$items' }, { $group: { _id: '$supplierId', ordered: { $sum: '$items.quantity' }, received: { $sum: '$items.receivedQuantity' }, days: { $push: { $cond: [{ $eq: ['$receivedStatus', 'RECEIVED'] }, { $divide: [{ $subtract: ['$updatedAt', '$purchaseDate'] }, DAY] }, null] } } } }]);
  const S = new Map(stats.map((x) => { const d = x.days.filter((v) => v !== null); return [String(x._id), { fillRatePct: x.ordered ? Math.round((x.received / x.ordered) * 1000) / 10 : null, avgDeliveryDays: d.length ? Math.round((d.reduce((s, v) => s + v, 0) / d.length) * 10) / 10 : null }]; }));
  const rows = quotes.map((q) => { const eff = effectivePrice(q); const lp = L.get(`${q.supplierId._id}:${q.productId._id}`); const st = S.get(String(q.supplierId._id)) || {}; return { quoteId: q._id, supplier: q.supplierId.name, supplierId: q.supplierId._id, product: q.productId.name, productId: q.productId._id, alternative: String(q.productId._id) !== String(productId), quotedUnit: q.unitName, quotedPrice: money(q.unitPrice), discountPercent: q.discountPercent, pricePerBaseUnit: money(eff), minQty: q.minQty, meetsMinQty: qty && q.minQty ? qty / q.unitFactor >= q.minQty : null, leadTimeDays: q.leadTimeDays ?? null, validUntil: q.validUntil, lastPaidPerBaseUnit: lp ? money(lp.perBase) : null, lastPurchasedAt: lp?.at || null, deliveryRecord: { avgDeliveryDays: st.avgDeliveryDays ?? null, fillRatePct: st.fillRatePct ?? null }, _eff: eff }; }).sort((a, b) => a._eff - b._eff);
  if (rows.length) rows[0].cheapest = true; rows.forEach((r) => delete r._eff);
  return { product: prod.name, baseUnit: prod.unit, quotes: rows, note: 'Delivery days are approximate: purchase date to the day the purchase was fully received. Fill rate is received / ordered over all purchases.' };
}
/** Products whose latest buying price moved against the one before it. */
async function priceChanges(businessId, { days = 180, thresholdPct = 5 }) {
  const since = new Date(Date.now() - days * DAY);
  const rows = await Purchase.aggregate([{ $match: { businessId: oid(businessId), purchaseDate: { $gte: since } } }, { $unwind: '$items' }, { $sort: { purchaseDate: 1 } }, { $group: { _id: '$items.productId', hist: { $push: { at: '$purchaseDate', supplierId: '$supplierId', perBase: { $divide: ['$items.unitCost', { $ifNull: ['$items.unitFactor', 1] }] } } } } }, { $limit: 3000 }]);
  const out = []; for (const r of rows) { if (r.hist.length < 2) continue; const a = r.hist[r.hist.length - 2]; const b = r.hist[r.hist.length - 1]; if (!a.perBase) continue; const pct = ((b.perBase - a.perBase) / a.perBase) * 100; if (Math.abs(pct) >= thresholdPct) out.push({ productId: r._id, previous: money(a.perBase), latest: money(b.perBase), changePct: Math.round(pct * 10) / 10, at: b.at, direction: pct > 0 ? 'UP' : 'DOWN' }); }
  const P = new Map((await Product.find({ _id: { $in: out.map((o) => o.productId) } }).select('name').lean()).map((p) => [String(p._id), p.name]));
  return out.map((o) => ({ ...o, name: P.get(String(o.productId)) })).sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct));
}

// ---------- landed costs ----------
async function addLandedCost(businessId, user, input) {
  const p = await Purchase.findOne({ _id: input.purchaseId, businessId }).select('status items'); if (!p) throw ApiError.notFound('Purchase not found'); if (p.status === 'CANCELLED') throw ApiError.conflict('This purchase is cancelled', 'CANCELLED');
  let amount = input.amount;
  if (input.expenseId) {
    const e = await Expense.findOne({ _id: input.expenseId, businessId, status: 'APPROVED' }); if (!e) throw ApiError.badRequest('Expense not found or not approved', 'EXPENSE_NOT_FOUND');
    const free = unallocated(e.amount, await transport.allocatedOf(businessId, e._id)); amount = amount || free;
    if (amount > free) throw ApiError.conflict(`Only ${money(free)} of this expense is left to allocate`, 'OVER_ALLOCATED');
  }
  if (!amount) throw ApiError.badRequest('Amount is required', 'AMOUNT_REQUIRED');
  const c = await LandedCost.create({ businessId, purchaseId: p._id, type: input.type, amount, allocateBy: input.allocateBy, payee: input.payee, reference: input.reference, expenseId: input.expenseId, date: input.date, note: input.note, createdBy: user._id });
  await AuditLog.create({ businessId, userId: user._id, action: 'hardware.landed.create', entityType: 'LandedCost', entityId: c._id, newValue: { purchaseId: p._id, amount } }); return c;
}
async function voidLanded(businessId, user, id, reason) {
  const c = await LandedCost.findOne({ _id: id, businessId }); if (!c) throw ApiError.notFound('Landed cost not found'); if (c.voided) throw ApiError.conflict('Already voided', 'ALREADY_VOIDED');
  c.voided = true; c.voidReason = reason; await c.save(); await AuditLog.create({ businessId, userId: user._id, action: 'hardware.landed.void', entityType: 'LandedCost', entityId: c._id, newValue: { reason } }); return c;
}
/** Per-line landed unit cost for one purchase. Does NOT change the stock ledger cost (see docs). */
async function landedBreakdown(businessId, purchaseId) {
  const p = await Purchase.findOne({ _id: purchaseId, businessId }).lean(); if (!p) throw ApiError.notFound('Purchase not found');
  const costs = await LandedCost.find({ businessId, purchaseId, voided: false }).lean();
  const lines = p.items.map((i, idx) => ({ key: idx, baseQty: i.quantity * (i.unitFactor || 1), value: i.total }));
  const extra = lines.map(() => 0); for (const c of costs) allocateLanded(lines, c.amount, c.allocateBy).forEach((v, i) => { extra[i] += v; });
  return { purchaseId, supplierId: p.supplierId, goodsTotal: money(p.total), landedTotal: money(costs.reduce((s, c) => s + c.amount, 0)), costs: costs.map((c) => ({ id: c._id, type: c.type, amount: money(c.amount), allocateBy: c.allocateBy, payee: c.payee })),
    lines: p.items.map((i, idx) => { const bq = lines[idx].baseQty; return { productId: i.productId, name: i.nameSnapshot, baseQuantity: bq, goodsCostPerBase: money(i.total / bq), landedExtra: money(extra[idx]), landedCostPerBase: money((i.total + extra[idx]) / bq) }; }) };
}
module.exports = { allocateLanded, effectivePrice, createQuote, listQuotes, setQuoteStatus, compare, priceChanges, addLandedCost, voidLanded, landedBreakdown };
