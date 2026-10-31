/** Hardware reports. Sales are COMPLETED only, refunded quantity netted off. Cents inside, decimals out. */
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const Product = require('../../models/Product');
const ProductVariant = require('../../models/ProductVariant');
const Customer = require('../../models/Customer');
const Purchase = require('../../models/Purchase');
const Quotation = require('../../models/Quotation');
const DeliveryOrder = require('../../models/DeliveryOrder');
const BranchInventory = require('../../models/BranchInventory');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { fromCents } = require('../../utils/money');
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const DAY = 86400000;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

const saleMatch = (businessId, { from, to, branchId }) => ({ businessId: oid(businessId), saleStatus: 'COMPLETED', ...(branchId ? { branchId: oid(branchId) } : {}), ...(from || to ? { soldAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) });
const money = (c) => fromCents(Math.round(c));

/** pure: net of refunds for a grouped sales row */
function netRow(r) { const keep = r.sold > 0 ? Math.max(0, r.sold - r.refunded) / r.sold : 0; return { qty: Math.max(0, r.sold - r.refunded), revenue: r.revenue * keep, cost: r.cost * keep }; }

async function salesByProduct(businessId, user, q) {
  if (q.branchId) assertBranchAccess(user, q.branchId);
  const by = q.by || 'product';
  const rows = await Sale.aggregate([{ $match: saleMatch(businessId, q) }, { $unwind: '$items' }, { $group: { _id: { p: '$items.productId', u: '$items.unitName' }, sold: { $sum: '$items.quantity' }, refunded: { $sum: '$items.refundedQuantity' }, revenue: { $sum: '$items.total' }, cost: { $sum: { $multiply: [{ $ifNull: ['$items.costPriceSnapshot', 0] }, '$items.quantity'] } } } }]);
  const prods = await Product.find({ _id: { $in: rows.map((r) => r._id.p) } }).select('name categoryId').populate('categoryId', 'name').lean(); const P = new Map(prods.map((p) => [String(p._id), p]));
  const m = new Map();
  for (const r of rows) { const p = P.get(String(r._id.p)) || {}; const n = netRow(r); const key = by === 'unit' ? (r._id.u || 'unit') : by === 'category' ? (p.categoryId?.name || '(none)') : `${p.name || 'Unknown'}${by === 'product' ? '' : ''}`; const k = by === 'product' ? `${key} (${r._id.u || 'unit'})` : key; const x = m.get(k) || { key: k, qty: 0, revenue: 0, cost: 0 }; x.qty += n.qty; x.revenue += n.revenue; x.cost += n.cost; m.set(k, x); }
  return { by, rows: [...m.values()].map((x) => ({ key: x.key, quantity: Math.round(x.qty * 1000) / 1000, revenue: money(x.revenue), cost: money(x.cost), margin: money(x.revenue - x.cost), marginPct: pct(x.revenue - x.cost, x.revenue) })).sort((a, b) => b.revenue - a.revenue) };
}

/** Profitability by contractor (customer) and, when a quotation links it, by project. */
async function contractorProfit(businessId, user, q) {
  if (q.branchId) assertBranchAccess(user, q.branchId);
  const rows = await Sale.aggregate([{ $match: { ...saleMatch(businessId, q), customerId: { $ne: null } } }, { $unwind: '$items' }, { $group: { _id: { s: '$_id', c: '$customerId' }, revenue: { $sum: '$items.total' }, cost: { $sum: { $multiply: [{ $ifNull: ['$items.costPriceSnapshot', 0] }, { $subtract: ['$items.quantity', { $ifNull: ['$items.refundedQuantity', 0] }] }] } } } }]);
  const byC = new Map(); const bySale = new Map();
  for (const r of rows) { const k = String(r._id.c); const x = byC.get(k) || { revenue: 0, cost: 0, sales: 0 }; x.revenue += r.revenue; x.cost += r.cost; x.sales += 1; byC.set(k, x); bySale.set(String(r._id.s), r); }
  const cust = await Customer.find({ _id: { $in: [...byC.keys()] } }).select('name outstandingBalance').lean(); const C = new Map(cust.map((c) => [String(c._id), c]));
  const contractors = [...byC.entries()].map(([id, x]) => ({ customerId: id, name: C.get(id)?.name, sales: x.sales, revenue: money(x.revenue), cost: money(x.cost), margin: money(x.revenue - x.cost), marginPct: pct(x.revenue - x.cost, x.revenue), balanceOwed: fromCents(C.get(id)?.outstandingBalance || 0) })).sort((a, b) => b.revenue - a.revenue);
  const quotes = await Quotation.find({ businessId, projectId: { $ne: null }, 'fulfilments.0': { $exists: true } }).select('projectId fulfilments').populate('projectId', 'name code').lean();
  const byP = new Map();
  for (const qt of quotes) for (const f of qt.fulfilments) { const s = bySale.get(String(f.saleId)); if (!s) continue; const k = String(qt.projectId._id); const x = byP.get(k) || { name: qt.projectId.name, code: qt.projectId.code, revenue: 0, cost: 0, invoices: 0 }; x.revenue += s.revenue; x.cost += s.cost; x.invoices += 1; byP.set(k, x); }
  const projects = [...byP.entries()].map(([id, x]) => ({ projectId: id, name: x.name, code: x.code, invoices: x.invoices, revenue: money(x.revenue), cost: money(x.cost), margin: money(x.revenue - x.cost), marginPct: pct(x.revenue - x.cost, x.revenue) })).sort((a, b) => b.revenue - a.revenue);
  return { contractors, projects };
}

/** Materials sitting in stock with no recent sale, grouped by age since last sale. */
async function slowMaterials(businessId, user, { days = 90, branchId, limit = 200 }) {
  if (branchId) assertBranchAccess(user, branchId);
  const inv = await BranchInventory.aggregate([{ $match: { businessId: oid(businessId), ...(branchId ? { branchId: oid(branchId) } : {}) } }, { $group: { _id: '$productId', onHand: { $sum: '$quantity' } } }, { $match: { onHand: { $gt: 0 } } }]);
  const last = await Sale.aggregate([{ $match: { businessId: oid(businessId), saleStatus: 'COMPLETED' } }, { $unwind: '$items' }, { $group: { _id: '$items.productId', last: { $max: '$soldAt' } } }]); const L = new Map(last.map((r) => [String(r._id), r.last]));
  const prods = await Product.find({ _id: { $in: inv.map((r) => r._id) }, businessId, status: 'active' }).select('name unit costPrice').lean(); const P = new Map(prods.map((p) => [String(p._id), p]));
  const now = Date.now(); const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, never: 0 }; const rows = [];
  for (const r of inv) { const p = P.get(String(r._id)); if (!p) continue; const l = L.get(String(r._id)); const age = l ? Math.floor((now - l.getTime()) / DAY) : null; const b = age === null ? 'never' : age <= 30 ? '0-30' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+'; buckets[b] += p.costPrice * r.onHand; if (age === null || age >= days) rows.push({ productId: r._id, name: p.name, unit: p.unit, onHand: r.onHand, stockValue: fromCents(Math.round(p.costPrice * r.onHand)), daysSinceSale: age }); }
  rows.sort((a, b) => b.stockValue - a.stockValue);
  return { days, ageing: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fromCents(Math.round(v))])), count: rows.length, rows: rows.slice(0, limit) };
}

/** Cost per base unit from the last two purchases of each product: who raised prices. */
async function supplierPriceChanges(businessId, { limit = 100 }) {
  const rows = await Purchase.aggregate([{ $match: { businessId: oid(businessId) } }, { $sort: { createdAt: -1 } }, { $unwind: '$items' }, { $project: { p: '$items.productId', s: '$supplierId', at: '$createdAt', perBase: { $divide: ['$items.unitCost', { $ifNull: ['$items.unitFactor', 1] }] } } }, { $group: { _id: { p: '$p', s: '$s' }, costs: { $push: { at: '$at', perBase: '$perBase' } } } }, { $match: { 'costs.1': { $exists: true } } }, { $limit: 5000 }]);
  const out = rows.map((r) => { const [now, prev] = r.costs; return { productId: r._id.p, supplierId: r._id.s, previous: prev.perBase, latest: now.perBase, at: now.at }; }).filter((r) => Math.round(r.latest) !== Math.round(r.previous));
  const prods = await Product.find({ _id: { $in: out.map((o) => o.productId) } }).select('name unit sellingPrice').lean(); const P = new Map(prods.map((p) => [String(p._id), p]));
  const res = out.map((o) => { const p = P.get(String(o.productId)) || {}; return { productId: o.productId, name: p.name, unit: p.unit, supplierId: o.supplierId, previousCost: fromCents(Math.round(o.previous)), latestCost: fromCents(Math.round(o.latest)), changePct: pct(o.latest - o.previous, o.previous), sellingPrice: fromCents(p.sellingPrice || 0), sellsBelowCost: (p.sellingPrice || 0) < o.latest, at: o.at }; }).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return { count: res.length, rows: res.slice(0, limit) };
}

async function pendingDeliveries(businessId, user, { branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const rows = await DeliveryOrder.find({ businessId, status: { $in: ['PENDING', 'LOADED', 'IN_TRANSIT', 'FAILED'] }, ...(branchId ? { branchId } : {}) }).select('number status scheduledFor address customerId driverId vehicle charge attempts').populate('customerId', 'name').populate('driverId', 'name').sort({ scheduledFor: 1 }).limit(300).lean();
  const now = Date.now();
  return { count: rows.length, overdue: rows.filter((r) => r.scheduledFor.getTime() < now).length, rows: rows.map((r) => ({ id: r._id, number: r.number, status: r.status, scheduledFor: r.scheduledFor, overdue: r.scheduledFor.getTime() < now, customer: r.customerId?.name, driver: r.driverId?.name, vehicle: r.vehicle, address: r.address, attempts: r.attempts })) };
}
/** Delivery charge vs cost, and the margin of the order that was delivered. */
async function deliveryProfit(businessId, user, { from, to, branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const q = { businessId, status: 'DELIVERED', ...(branchId ? { branchId } : {}) }; if (from || to) q.scheduledFor = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const ds = await DeliveryOrder.find(q).select('number saleId charge cost scheduledFor customerId').populate('customerId', 'name').lean();
  const sales = await Sale.find({ _id: { $in: ds.map((d) => d.saleId).filter(Boolean) } }).select('items total').lean(); const S = new Map(sales.map((s) => [String(s._id), s]));
  const rows = ds.map((d) => { const s = d.saleId ? S.get(String(d.saleId)) : null; const orderCost = s ? s.items.reduce((a, i) => a + (i.costPriceSnapshot || 0) * i.quantity, 0) : 0; const orderMargin = s ? s.total - orderCost : null; return { number: d.number, customer: d.customerId?.name, charge: fromCents(d.charge), cost: fromCents(d.cost), deliveryMargin: fromCents(d.charge - d.cost), orderMargin: orderMargin === null ? null : money(orderMargin), orderMarginAfterDelivery: orderMargin === null ? null : money(orderMargin + d.charge - d.cost) }; });
  const t = ds.reduce((a, d) => ({ charge: a.charge + d.charge, cost: a.cost + d.cost }), { charge: 0, cost: 0 });
  return { deliveries: ds.length, charged: fromCents(t.charge), cost: fromCents(t.cost), margin: fromCents(t.charge - t.cost), rows };
}
async function creditOverdue(businessId) {
  const now = new Date();
  const owing = await Customer.find({ businessId, outstandingBalance: { $gt: 0 } }).select('name phone outstandingBalance creditLimit').sort({ outstandingBalance: -1 }).limit(200).lean();
  const inv = await Sale.find({ businessId, saleStatus: 'COMPLETED', balance: { $gt: 0 }, dueDate: { $lt: now } }).select('invoiceNumber customerId balance dueDate').populate('customerId', 'name phone').sort({ dueDate: 1 }).limit(300).lean();
  return { customers: owing.map((c) => ({ id: c._id, name: c.name, phone: c.phone, owed: fromCents(c.outstandingBalance), limit: fromCents(c.creditLimit || 0), usedPct: pct(c.outstandingBalance, c.creditLimit || 0) })), overdueInvoices: inv.map((s) => ({ invoice: s.invoiceNumber, customer: s.customerId?.name, phone: s.customerId?.phone, balance: fromCents(s.balance), dueDate: s.dueDate, daysOverdue: Math.floor((now - s.dueDate) / DAY) })), totalOwed: fromCents(owing.reduce((a, c) => a + c.outstandingBalance, 0)), totalOverdue: fromCents(inv.reduce((a, s) => a + s.balance, 0)) };
}
async function stockValuation(businessId, user, { branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const rows = await BranchInventory.aggregate([{ $match: { businessId: oid(businessId), quantity: { $gt: 0 }, ...(branchId ? { branchId: oid(branchId) } : {}) } }, { $group: { _id: { p: '$productId', v: '$variantId', b: '$branchId' }, qty: { $sum: '$quantity' } } }]);
  const [prods, vars] = await Promise.all([Product.find({ _id: { $in: rows.map((r) => r._id.p) } }).select('costPrice sellingPrice').lean(), ProductVariant.find({ _id: { $in: rows.filter((r) => r._id.v).map((r) => r._id.v) } }).select('costPrice sellingPrice').lean()]);
  const P = new Map(prods.map((p) => [String(p._id), p])); const V = new Map(vars.map((v) => [String(v._id), v])); const byB = new Map();
  for (const r of rows) { const it = r._id.v ? V.get(String(r._id.v)) : P.get(String(r._id.p)); if (!it) continue; const k = String(r._id.b); const x = byB.get(k) || { cost: 0, retail: 0, lines: 0 }; x.cost += it.costPrice * r.qty; x.retail += it.sellingPrice * r.qty; x.lines += 1; byB.set(k, x); }
  const list = [...byB.entries()].map(([b, x]) => ({ branchId: b, lines: x.lines, costValue: money(x.cost), retailValue: money(x.retail), potentialMargin: money(x.retail - x.cost) }));
  return { branches: list, totalCost: money([...byB.values()].reduce((a, x) => a + x.cost, 0)), totalRetail: money([...byB.values()].reduce((a, x) => a + x.retail, 0)), note: 'Shop-floor stock only. Warehouse stock is valued from the wholesale reports.' };
}
async function dashboard(businessId, user, { branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const [pending, cred, openOrders, expiring, low] = await Promise.all([pendingDeliveries(businessId, user, { branchId }), creditOverdue(businessId), Quotation.countDocuments({ businessId, status: { $in: ['APPROVED', 'PARTIALLY_FULFILLED'] } }), Quotation.countDocuments({ businessId, status: { $in: ['DRAFT', 'SENT'] }, validUntil: { $gte: new Date(), $lte: new Date(Date.now() + 3 * DAY) } }),
    BranchInventory.countDocuments({ businessId, ...(branchId ? { branchId } : {}), $expr: { $lte: [{ $subtract: ['$quantity', '$reservedQuantity'] }, 0] } })]);
  return { pendingDeliveries: pending.count, overdueDeliveries: pending.overdue, openOrders, quotationsExpiringIn3Days: expiring, outOfStockLines: low, contractorBalances: cred.customers.slice(0, 5), totalOwed: cred.totalOwed, totalOverdue: cred.totalOverdue };
}
module.exports = { netRow, salesByProduct, contractorProfit, slowMaterials, supplierPriceChanges, pendingDeliveries, deliveryProfit, creditOverdue, stockValuation, dashboard };
