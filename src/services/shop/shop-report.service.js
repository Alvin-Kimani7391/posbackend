/** Owner/manager reports for a shop: end-of-day, margins, dead stock, valuation, reorder list, customer credit aging + statements. Money out = decimal. */
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const Payment = require('../../models/Payment');
const Expense = require('../../models/Expense');
const Refund = require('../../models/Refund');
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const Customer = require('../../models/Customer');
const CustomerLedger = require('../../models/CustomerLedger');
const BranchInventory = require('../../models/BranchInventory');
const CashShift = require('../../models/CashShift');
const { getBusinessContext } = require('../../utils/businessContext');
const { zonedToUtc, addDays, localDateTime, todayIn } = require('../../utils/hospitalityTime');
const { fromCents } = require('../../utils/money');
const { assertBranchAccess } = require('../../utils/branchAccess');
const ApiError = require('../../utils/ApiError');

const oid = (x) => new mongoose.Types.ObjectId(String(x));
const D = fromCents;

async function dayRange(businessId, date) {
  const ctx = await getBusinessContext(businessId);
  const ymd = date || todayIn(ctx.timezone);
  return { ymd, from: zonedToUtc(ymd, '00:00', ctx.timezone), to: zonedToUtc(addDays(ymd, 1), '00:00', ctx.timezone), tz: ctx.timezone, ctx };
}

/** End-of-day (Z) report for one branch and day (business time zone), optionally one cashier. */
async function endOfDay(businessId, user, { date, branchId, cashierId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const { ymd, from, to, tz } = await dayRange(businessId, date);
  const sm = { businessId: oid(businessId), soldAt: { $gte: from, $lt: to } };
  if (branchId) sm.branchId = oid(branchId); if (cashierId) sm.cashierId = oid(cashierId);
  const completed = { ...sm, saleStatus: 'COMPLETED' };
  const pm = { businessId: oid(businessId), status: 'SUCCESS', completedAt: { $gte: from, $lt: to } };
  if (branchId) pm.branchId = oid(branchId);
  const em = { businessId: oid(businessId), expenseDate: { $gte: from, $lt: to }, status: { $ne: 'REJECTED' } };
  if (branchId) em.branchId = oid(branchId);

  const [tot, cancelled, byHour, top, byCashier, pays, expenses, refunds, shifts, ledgerPays] = await Promise.all([
    Sale.aggregate([{ $match: completed }, { $group: { _id: null, count: { $sum: 1 }, gross: { $sum: { $add: ['$subtotal', '$tax'] } }, total: { $sum: '$total' }, itemDiscount: { $sum: '$itemDiscount' }, cartDiscount: { $sum: '$cartDiscount' }, tax: { $sum: '$tax' }, paid: { $sum: '$amountPaid' }, onCredit: { $sum: '$balance' } } }]),
    Sale.aggregate([{ $match: { ...sm, saleStatus: 'CANCELLED' } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }]),
    Sale.aggregate([{ $match: completed }, { $group: { _id: null, rows: { $push: { t: '$soldAt', v: '$total' } } } }]),
    Sale.aggregate([{ $match: completed }, { $unwind: '$items' }, { $group: { _id: '$items.productId', name: { $first: '$items.nameSnapshot' }, qty: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' }, cost: { $sum: { $multiply: ['$items.costPriceSnapshot', { $ifNull: ['$items.baseQuantity', '$items.quantity'] }] } } } }, { $sort: { revenue: -1 } }, { $limit: 10 }]),
    Sale.aggregate([{ $match: completed }, { $group: { _id: '$cashierId', count: { $sum: 1 }, total: { $sum: '$total' } } }, { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } }, { $sort: { total: -1 } }]),
    Payment.aggregate([{ $match: pm }, { $group: { _id: { method: '$method', out: { $cond: [{ $ifNull: ['$refundId', false] }, true, false] } }, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Expense.aggregate([{ $match: em }, { $group: { _id: '$paymentMethod', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Refund.aggregate([{ $match: { businessId: oid(businessId), status: { $in: ['APPROVED', 'COMPLETED'] }, createdAt: { $gte: from, $lt: to }, ...(branchId ? { branchId: oid(branchId) } : {}) } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } }]),
    CashShift.find({ businessId, ...(branchId ? { branchId } : {}), openedAt: { $gte: from, $lt: to } }).select('status openedAt closedAt cashierId openingCash expectedCash actualCash cashDifference').populate('cashierId', 'name').limit(50).lean().catch(() => []),
    CustomerLedger.aggregate([{ $match: { businessId: oid(businessId), transactionType: 'PAYMENT', createdAt: { $gte: from, $lt: to } } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$credit' } } }]),
  ]);
  const t = tot[0] || {};
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0, count: 0 }));
  for (const r of (byHour[0] && byHour[0].rows) || []) { const h = Math.floor(localDateTime(r.t, tz).minutes / 60); hourly[h].sales += r.v; hourly[h].count += 1; }
  const methods = {};
  for (const p of pays) { const m = (methods[p._id.method] = methods[p._id.method] || { in: 0, out: 0, count: 0 }); if (p._id.out) m.out += p.total; else m.in += p.total; m.count += p.count; }
  const cashIn = (methods.CASH || {}).in || 0; const cashOut = (methods.CASH || {}).out || 0;
  const cashExpenses = (expenses.find((e) => e._id === 'CASH') || {}).total || 0;
  const cogs = top.reduce((s, x) => s + x.cost, 0);
  return {
    date: ymd, timezone: tz, branchId: branchId || null,
    sales: { count: t.count || 0, total: D(t.total), subtotal: D((t.gross || 0) - (t.tax || 0)), discounts: D((t.itemDiscount || 0) + (t.cartDiscount || 0)), tax: D(t.tax), collected: D(t.paid), soldOnCredit: D(t.onCredit), averageSale: D(t.count ? Math.round(t.total / t.count) : 0) },
    cancelled: { count: (cancelled[0] || {}).count || 0, total: D((cancelled[0] || {}).total) },
    refunds: { count: (refunds[0] || {}).count || 0, total: D((refunds[0] || {}).total) },
    paymentsByMethod: Object.entries(methods).map(([method, v]) => ({ method, received: D(v.in), paidOut: D(v.out), net: D(v.in - v.out), count: v.count })),
    creditCollected: { count: (ledgerPays[0] || {}).count || 0, total: D((ledgerPays[0] || {}).total) },
    expenses: { total: D(expenses.reduce((s, e) => s + e.total, 0)), byMethod: expenses.map((e) => ({ method: e._id, total: D(e.total), count: e.count })) },
    cash: { received: D(cashIn), refundedOut: D(cashOut), cashExpenses: D(cashExpenses), expectedNetCash: D(cashIn - cashOut - cashExpenses), note: 'Estimate from recorded payments. The authoritative drawer count is the shift close.' },
    topProducts: top.map((x) => ({ productId: x._id, name: x.name, quantity: x.qty, revenue: D(x.revenue) })),
    byCashier: byCashier.map((c) => ({ cashierId: c._id, name: (c.u[0] || {}).name || 'Unknown', count: c.count, total: D(c.total) })),
    hourly: hourly.filter((h) => h.count).map((h) => ({ hour: h.hour, count: h.count, sales: D(h.sales) })),
    shifts: shifts.map((s) => ({ ...s, openingCash: D(s.openingCash), expectedCash: D(s.expectedCash), actualCash: D(s.actualCash), cashDifference: D(s.cashDifference) })),
    topProductsCostOfGoods: D(cogs),
  };
}

/** Margin by product or category over a period. */
async function margins(businessId, user, { from, to, branchId, groupBy = 'product', limit = 50 }) {
  if (branchId) assertBranchAccess(user, branchId);
  const m = { businessId: oid(businessId), saleStatus: 'COMPLETED', soldAt: { $gte: from, $lte: to } };
  if (branchId) m.branchId = oid(branchId);
  const rows = await Sale.aggregate([{ $match: m }, { $unwind: '$items' },
    { $group: { _id: '$items.productId', name: { $first: '$items.nameSnapshot' }, qty: { $sum: '$items.quantity' }, revenue: { $sum: { $subtract: ['$items.total', '$items.taxAmount'] } }, cost: { $sum: { $multiply: ['$items.costPriceSnapshot', { $ifNull: ['$items.baseQuantity', '$items.quantity'] }] } } } }]);
  let out = rows.map((r) => ({ key: r._id, name: r.name, quantity: r.qty, revenue: r.revenue, cost: r.cost, profit: r.revenue - r.cost }));
  if (groupBy === 'category') {
    const ps = await Product.find({ _id: { $in: out.map((o) => o.key) }, businessId }).select('categoryId').lean();
    const cat = new Map(ps.map((p) => [String(p._id), p.categoryId ? String(p.categoryId) : 'none']));
    const names = new Map((await Category.find({ businessId }).select('name').lean()).map((c) => [String(c._id), c.name]));
    const g = new Map();
    for (const o of out) { const k = cat.get(String(o.key)) || 'none'; const x = g.get(k) || { key: k, name: k === 'none' ? 'Uncategorised' : names.get(k) || 'Unknown', quantity: 0, revenue: 0, cost: 0, profit: 0 }; x.quantity += o.quantity; x.revenue += o.revenue; x.cost += o.cost; x.profit += o.profit; g.set(k, x); }
    out = [...g.values()];
  }
  out.sort((a, b) => b.profit - a.profit);
  const sum = out.reduce((s, o) => ({ revenue: s.revenue + o.revenue, cost: s.cost + o.cost }), { revenue: 0, cost: 0 });
  const fmt = (o) => ({ ...o, revenue: D(o.revenue), cost: D(o.cost), profit: D(o.profit), marginPercent: o.revenue ? Math.round((o.profit / o.revenue) * 1000) / 10 : null });
  return { groupBy, totals: { revenue: D(sum.revenue), cost: D(sum.cost), profit: D(sum.revenue - sum.cost), marginPercent: sum.revenue ? Math.round(((sum.revenue - sum.cost) / sum.revenue) * 1000) / 10 : null },
    best: out.slice(0, limit).map(fmt), worst: [...out].reverse().slice(0, limit).map(fmt), note: 'Revenue excludes tax. Cost uses the cost price recorded at the time of sale.' };
}

/** Stock on hand that has not sold for `days` days (and by how much money is tied up). */
async function deadStock(businessId, user, { days = 60, branchId, limit = 100 }) {
  if (branchId) assertBranchAccess(user, branchId);
  const since = new Date(Date.now() - days * 86400000);
  const im = { businessId: oid(businessId), quantity: { $gt: 0 } }; if (branchId) im.branchId = oid(branchId);
  const sm = { businessId: oid(businessId), saleStatus: 'COMPLETED', soldAt: { $gte: since } }; if (branchId) sm.branchId = oid(branchId);
  const [stock, sold] = await Promise.all([
    BranchInventory.aggregate([{ $match: im }, { $group: { _id: '$productId', qty: { $sum: '$quantity' } } }]),
    Sale.aggregate([{ $match: sm }, { $unwind: '$items' }, { $group: { _id: '$items.productId' } }]),
  ]);
  const soldSet = new Set(sold.map((s) => String(s._id)));
  const idle = stock.filter((s) => !soldSet.has(String(s._id)));
  const ps = await Product.find({ _id: { $in: idle.map((s) => s._id) }, businessId, status: 'active' }).select('name sku costPrice sellingPrice createdAt').lean();
  const P = new Map(ps.map((p) => [String(p._id), p]));
  const items = idle.filter((s) => P.has(String(s._id))).map((s) => { const p = P.get(String(s._id)); return { productId: s._id, name: p.name, sku: p.sku, onHand: s.qty, costValue: s.qty * p.costPrice, retailValue: s.qty * p.sellingPrice, addedAt: p.createdAt }; })
    .filter((x) => new Date(x.addedAt) < since).sort((a, b) => b.costValue - a.costValue);
  return { days, count: items.length, tiedUpCost: D(items.reduce((s, x) => s + x.costValue, 0)), items: items.slice(0, limit).map((x) => ({ ...x, costValue: D(x.costValue), retailValue: D(x.retailValue) })) };
}

/** What the stock on the shelf is worth, by category. */
async function stockValuation(businessId, user, { branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const im = { businessId: oid(businessId), quantity: { $gt: 0 } }; if (branchId) im.branchId = oid(branchId);
  const inv = await BranchInventory.aggregate([{ $match: im }, { $group: { _id: '$productId', qty: { $sum: '$quantity' } } }]);
  const ps = await Product.find({ _id: { $in: inv.map((i) => i._id) }, businessId }).select('categoryId costPrice sellingPrice').lean();
  const P = new Map(ps.map((p) => [String(p._id), p]));
  const names = new Map((await Category.find({ businessId }).select('name').lean()).map((c) => [String(c._id), c.name]));
  const g = new Map(); let units = 0;
  for (const i of inv) {
    const p = P.get(String(i._id)); if (!p) continue;
    const k = p.categoryId ? String(p.categoryId) : 'none';
    const x = g.get(k) || { categoryId: k === 'none' ? null : k, name: k === 'none' ? 'Uncategorised' : names.get(k) || 'Unknown', products: 0, units: 0, cost: 0, retail: 0 };
    x.products += 1; x.units += i.qty; x.cost += i.qty * p.costPrice; x.retail += i.qty * p.sellingPrice; g.set(k, x); units += i.qty;
  }
  const rows = [...g.values()].sort((a, b) => b.cost - a.cost);
  const cost = rows.reduce((s, r) => s + r.cost, 0); const retail = rows.reduce((s, r) => s + r.retail, 0);
  return { totals: { units, cost: D(cost), retail: D(retail), potentialProfit: D(retail - cost) }, byCategory: rows.map((r) => ({ ...r, cost: D(r.cost), retail: D(r.retail), potentialProfit: D(r.retail - r.cost) })) };
}

/** Low or fast-selling items with a suggested order quantity (cover `coverDays` of sales, using the last `lookbackDays`). */
async function reorderSuggestions(businessId, user, { branchId, lookbackDays = 30, coverDays = 14, limit = 200 }) {
  if (branchId) assertBranchAccess(user, branchId);
  const since = new Date(Date.now() - lookbackDays * 86400000);
  const im = { businessId: oid(businessId) }; if (branchId) im.branchId = oid(branchId);
  const sm = { businessId: oid(businessId), saleStatus: 'COMPLETED', soldAt: { $gte: since } }; if (branchId) sm.branchId = oid(branchId);
  const [inv, sold] = await Promise.all([
    BranchInventory.aggregate([{ $match: im }, { $group: { _id: '$productId', qty: { $sum: '$quantity' }, reserved: { $sum: '$reservedQuantity' }, threshold: { $max: '$lowStockThreshold' } } }]),
    Sale.aggregate([{ $match: sm }, { $unwind: '$items' }, { $group: { _id: '$items.productId', qty: { $sum: { $ifNull: ['$items.baseQuantity', '$items.quantity'] } } } }]),
  ]);
  const S = new Map(sold.map((s) => [String(s._id), s.qty]));
  const ps = await Product.find({ _id: { $in: inv.map((i) => i._id) }, businessId, status: 'active', trackInventory: true }).select('name sku costPrice unit lowStockThreshold').lean();
  const P = new Map(ps.map((p) => [String(p._id), p]));
  const rows = [];
  for (const i of inv) {
    const p = P.get(String(i._id)); if (!p) continue;
    const available = i.qty - i.reserved; const perDay = (S.get(String(i._id)) || 0) / lookbackDays;
    const threshold = i.threshold ?? p.lowStockThreshold ?? 5;
    const daysLeft = perDay > 0 ? available / perDay : null;
    const needsOrder = available <= threshold || (daysLeft !== null && daysLeft < coverDays / 2);
    if (!needsOrder) continue;
    const target = Math.max(threshold * 2, Math.ceil(perDay * coverDays));
    const suggested = Math.max(0, Math.ceil(target - available));
    if (!suggested) continue;
    rows.push({ productId: i._id, name: p.name, sku: p.sku, unit: p.unit, onHand: available, reorderLevel: threshold, soldPerDay: Math.round(perDay * 100) / 100, daysLeft: daysLeft === null ? null : Math.round(daysLeft * 10) / 10, suggestedQty: suggested, estimatedCost: D(suggested * p.costPrice), urgency: available <= 0 ? 'OUT' : (daysLeft !== null && daysLeft < 3) || available <= threshold / 2 ? 'HIGH' : 'NORMAL' });
  }
  const rank = { OUT: 0, HIGH: 1, NORMAL: 2 };
  rows.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
  return { lookbackDays, coverDays, count: rows.length, estimatedTotal: D(rows.reduce((s, r) => s + Math.round(r.estimatedCost * 100), 0)), items: rows.slice(0, limit) };
}

const BUCKETS = [{ key: 'current', max: 30 }, { key: 'd31_60', max: 60 }, { key: 'd61_90', max: 90 }, { key: 'over90', max: Infinity }];
/** pure: oldest debts are paid first; what is left is aged from the date it was charged. */
function ageDebts(entries, now = new Date()) {
  let credits = entries.reduce((s, e) => s + (e.credit || 0), 0);
  const open = [];
  for (const e of entries) {
    if (!(e.debit > 0)) continue;
    const used = Math.min(credits, e.debit); credits -= used;
    if (e.debit - used > 0) open.push({ at: e.createdAt, amount: e.debit - used });
  }
  const buckets = { current: 0, d31_60: 0, d61_90: 0, over90: 0 };
  for (const o of open) { const age = Math.floor((now - new Date(o.at)) / 86400000); const b = BUCKETS.find((x) => age <= x.max); buckets[b.key] += o.amount; }
  return { buckets, open, oldestDays: open.length ? Math.floor((now - new Date(open[0].at)) / 86400000) : 0 };
}

async function creditAging(businessId, { minBalance = 1, limit = 500 } = {}) {
  const custs = await Customer.find({ businessId, outstandingBalance: { $gte: minBalance } }).select('name phone outstandingBalance creditLimit smsOptOut').sort({ outstandingBalance: -1 }).limit(limit).lean();
  const ledger = await CustomerLedger.find({ businessId, customerId: { $in: custs.map((c) => c._id) } }).select('customerId debit credit createdAt').sort({ createdAt: 1 }).lean();
  const by = new Map(); for (const l of ledger) { const k = String(l.customerId); (by.get(k) || by.set(k, []).get(k)).push(l); }
  const totals = { current: 0, d31_60: 0, d61_90: 0, over90: 0 };
  const rows = custs.map((c) => { const a = ageDebts(by.get(String(c._id)) || []); for (const k of Object.keys(totals)) totals[k] += a.buckets[k]; return { customerId: c._id, name: c.name, phone: c.phone, balance: D(c.outstandingBalance), creditLimit: D(c.creditLimit), oldestDays: a.oldestDays, current: D(a.buckets.current), d31_60: D(a.buckets.d31_60), d61_90: D(a.buckets.d61_90), over90: D(a.buckets.over90), canSms: !!c.phone && !c.smsOptOut }; });
  return { count: rows.length, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, D(v)])), total: D(Object.values(totals).reduce((a, b) => a + b, 0)), customers: rows };
}

/** Statement for one customer: opening balance, every movement in the period, closing balance and aging. */
async function customerStatement(businessId, customerId, { from, to }) {
  const c = await Customer.findOne({ _id: customerId, businessId }).select('name phone address outstandingBalance creditLimit').lean();
  if (!c) throw ApiError.notFound('Customer not found');
  const end = to || new Date(); const start = from || new Date(end.getTime() - 90 * 86400000);
  const [before, within, all] = await Promise.all([
    CustomerLedger.findOne({ businessId, customerId, createdAt: { $lt: start } }).sort({ createdAt: -1 }).select('balance').lean(),
    CustomerLedger.find({ businessId, customerId, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean(),
    CustomerLedger.find({ businessId, customerId }).select('debit credit createdAt').sort({ createdAt: 1 }).lean(),
  ]);
  const a = ageDebts(all);
  return {
    customer: { id: c._id, name: c.name, phone: c.phone, address: c.address, creditLimit: D(c.creditLimit) },
    period: { from: start, to: end }, openingBalance: D(before ? before.balance : 0),
    entries: within.map((e) => ({ date: e.createdAt, type: e.transactionType, reference: e.referenceType, referenceId: e.referenceId, debit: D(e.debit), credit: D(e.credit), balance: D(e.balance), notes: e.notes })),
    totalCharged: D(within.reduce((s, e) => s + (e.debit || 0), 0)), totalPaid: D(within.reduce((s, e) => s + (e.credit || 0), 0)),
    closingBalance: D(within.length ? within[within.length - 1].balance : (before ? before.balance : 0)), currentBalance: D(c.outstandingBalance),
    aging: Object.fromEntries(Object.entries(a.buckets).map(([k, v]) => [k, D(v)])),
  };
}

module.exports = { endOfDay, margins, deadStock, stockValuation, reorderSuggestions, creditAging, customerStatement, ageDebts };
