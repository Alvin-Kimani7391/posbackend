'use strict';
/**
 * weeklyReport/data.js - gathers everything the weekly email + the two PDFs show, for ONE business.
 * Read-only. Money is integer cents in the business currency (same as the rest of the POS).
 *
 * Reporting week = the 7 full days that ended yesterday (shop-local time), e.g. a Saturday-10:00 send covers
 * last Saturday ... Friday. It is compared with the 3 weeks before it.
 */
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const Branch = require('../../models/Branch');
const Business = require('../../models/Business');
const Product = require('../../models/Product');
const ProductVariant = require('../../models/ProductVariant');
const BranchInventory = require('../../models/BranchInventory');
const Batch = require('../../models/Batch');
const Supplier = require('../../models/Supplier');
const { getBusinessContext } = require('../../utils/businessContext');

const DAY = 86400000;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local calendar date (YYYY-MM-DD) of an instant in a timezone. */
function localDate(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
/** UTC instant of local midnight of YYYY-MM-DD in tz. */
function zonedMidnight(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess));
    const g = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
    const shown = Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, g.second);
    guess += Date.UTC(y, m - 1, d) - shown;
  }
  return guess;
}
const addDays = (dateStr, n) => new Date(Date.UTC(...dateStr.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), 12) + n * DAY).toISOString().slice(0, 10);
const weekdayOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : (cur > 0 ? null : 0));

const variantLabel = (name, v) => {
  const attrs = v && v.attributes ? (v.attributes instanceof Map ? [...v.attributes.values()] : Object.values(v.attributes)) : [];
  return attrs.length ? `${name} (${attrs.join(' / ')})` : name;
};

/* ------------------------------------------------------------------ sales */
async function salesSection(businessId, tz, today, ctx) {
  const lastDay = addDays(today, -1);
  const firstDay = addDays(lastDay, -27);               // 4 weeks
  const from = zonedMidnight(firstDay, tz);
  const to = zonedMidnight(today, tz);
  const base = { businessId: oid(businessId), saleStatus: 'COMPLETED', soldAt: { $gte: new Date(from), $lt: new Date(to) } };
  const dayExpr = { $dateToString: { format: '%Y-%m-%d', date: '$soldAt', timezone: tz } };

  const [bySale, byItem, topProducts, byBranch] = await Promise.all([
    Sale.aggregate([{ $match: base }, { $group: { _id: dayExpr, revenue: { $sum: '$total' }, tx: { $sum: 1 } } }]),
    Sale.aggregate([{ $match: base }, { $unwind: '$items' }, { $group: { _id: dayExpr,
      units: { $sum: { $ifNull: ['$items.baseQuantity', '$items.quantity'] } },
      profit: { $sum: { $subtract: [{ $subtract: ['$items.total', { $ifNull: ['$items.taxAmount', 0] }] }, { $multiply: ['$items.costPriceSnapshot', '$items.quantity'] }] } } } }]),
    Sale.aggregate([{ $match: { ...base, soldAt: { $gte: new Date(zonedMidnight(addDays(lastDay, -6), tz)), $lt: new Date(to) } } }, { $unwind: '$items' },
      { $group: { _id: { p: '$items.productId', n: '$items.nameSnapshot' }, units: { $sum: { $ifNull: ['$items.baseQuantity', '$items.quantity'] } }, revenue: { $sum: '$items.total' } } },
      { $sort: { revenue: -1 } }, { $limit: 8 }]),
    Sale.aggregate([{ $match: { ...base, soldAt: { $gte: new Date(zonedMidnight(addDays(lastDay, -6), tz)), $lt: new Date(to) } } }, { $group: { _id: '$branchId', revenue: { $sum: '$total' }, tx: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
  ]);

  const saleMap = new Map(bySale.map((r) => [r._id, r]));
  const itemMap = new Map(byItem.map((r) => [r._id, r]));
  const days = [];
  for (let i = 0; i < 28; i += 1) {
    const date = addDays(firstDay, i);
    const s = saleMap.get(date) || {}; const it = itemMap.get(date) || {};
    days.push({ date, weekday: WEEKDAYS[weekdayOf(date)], revenue: s.revenue || 0, tx: s.tx || 0, units: Math.round((it.units || 0) * 100) / 100, profit: Math.round(it.profit || 0) });
  }
  const sum = (arr) => arr.reduce((a, d) => ({ revenue: a.revenue + d.revenue, tx: a.tx + d.tx, units: a.units + d.units, profit: a.profit + d.profit }), { revenue: 0, tx: 0, units: 0, profit: 0 });
  const weeks = [3, 2, 1, 0].map((k) => {                // oldest -> newest; index 3 = this week
    const slice = days.slice((3 - k) * 7, (3 - k) * 7 + 7);
    const t = sum(slice);
    return { start: slice[0].date, end: slice[6].date, days: slice, ...t, avgBasket: t.tx ? Math.round(t.revenue / t.tx) : 0 };
  });
  const [w4, w3, w2, w1] = weeks;                         // w1 = this week
  const cur = w1; const prev = w2;
  const prior3 = [w4, w3, w2];
  const avg3 = { revenue: Math.round(prior3.reduce((a, w) => a + w.revenue, 0) / 3), tx: Math.round(prior3.reduce((a, w) => a + w.tx, 0) / 3), profit: Math.round(prior3.reduce((a, w) => a + w.profit, 0) / 3) };
  const bestDay = [...cur.days].sort((a, b) => b.revenue - a.revenue)[0];
  const quietDay = [...cur.days].sort((a, b) => a.revenue - b.revenue)[0];

  const branches = await Branch.find({ _id: { $in: byBranch.map((b) => b._id).filter(Boolean) } }).select('name').lean();
  const bn = new Map(branches.map((b) => [String(b._id), b.name]));

  return {
    period: { start: cur.start, end: cur.end },
    thisWeek: cur, lastWeek: prev, weeks,
    dayCompare: cur.days.map((d, i) => ({ ...d, prevRevenue: prev.days[i].revenue, change: pct(d.revenue, prev.days[i].revenue) })),
    change: {
      revenue: pct(cur.revenue, prev.revenue), tx: pct(cur.tx, prev.tx), profit: pct(cur.profit, prev.profit),
      avgBasket: pct(cur.avgBasket, prev.avgBasket), vsAvg3: pct(cur.revenue, avg3.revenue),
    },
    avg3, bestDay, quietDay,
    margin: cur.revenue ? Math.round((cur.profit / cur.revenue) * 1000) / 10 : 0,
    topProducts: topProducts.map((p) => ({ name: p._id.n, units: Math.round(p.units * 100) / 100, revenue: p.revenue })),
    branches: byBranch.map((b) => ({ name: bn.get(String(b._id)) || 'Branch', revenue: b.revenue, tx: b.tx })),
    hasSales: cur.tx > 0 || prev.tx > 0 || avg3.tx > 0,
  };
}

/* -------------------------------------------------------------- low stock */
async function lowStockSection(businessId) {
  const rows = await BranchInventory.find({ businessId: oid(businessId) }).select('branchId productId variantId quantity reservedQuantity lowStockThreshold').limit(50000).lean();
  const prodIds = [...new Set(rows.map((r) => String(r.productId)))];
  const prods = await Product.find({ _id: { $in: prodIds }, status: { $ne: 'archived' }, trackInventory: true }).select('name sku costPrice sellingPrice').lean();
  const pm = new Map(prods.map((p) => [String(p._id), p]));
  const varIds = rows.filter((r) => r.variantId).map((r) => r.variantId);
  const vars = varIds.length ? await ProductVariant.find({ _id: { $in: varIds } }).select('sku attributes costPrice sellingPrice lowStockThreshold').lean() : [];
  const vm = new Map(vars.map((v) => [String(v._id), v]));
  const branches = await Branch.find({ businessId: oid(businessId) }).select('name').lean();
  const bn = new Map(branches.map((b) => [String(b._id), b.name]));

  const items = [];
  for (const r of rows) {
    const p = pm.get(String(r.productId)); if (!p) continue;
    const v = r.variantId ? vm.get(String(r.variantId)) : null;
    const threshold = r.lowStockThreshold ?? (v && v.lowStockThreshold) ?? 5;
    const avail = r.quantity - (r.reservedQuantity || 0);
    const state = r.quantity <= 0 ? 'out' : avail <= threshold ? 'low' : null;
    if (!state) continue;
    const cost = (v && v.costPrice) || p.costPrice || 0; const price = (v && v.sellingPrice) || p.sellingPrice || 0;
    const target = Math.max(threshold * 2, threshold + 1);
    const reorderQty = Math.max(0, Math.ceil(target - Math.max(r.quantity, 0)));
    items.push({
      name: variantLabel(p.name, v), sku: (v && v.sku) || p.sku || '', branch: bn.get(String(r.branchId)) || 'Branch',
      quantity: Math.max(r.quantity, 0), threshold, state, cost, price, reorderQty, reorderCost: reorderQty * cost,
      stockValue: Math.max(r.quantity, 0) * cost,
    });
  }
  items.sort((a, b) => (a.state === b.state ? a.quantity - b.quantity || a.name.localeCompare(b.name) : a.state === 'out' ? -1 : 1));
  const out = items.filter((i) => i.state === 'out'); const low = items.filter((i) => i.state === 'low');
  const byBranch = {};
  items.forEach((i) => { const b = byBranch[i.branch] || (byBranch[i.branch] = { out: 0, low: 0 }); b[i.state] += 1; });
  return {
    items, outCount: out.length, lowCount: low.length, total: items.length,
    reorderCost: items.reduce((a, i) => a + i.reorderCost, 0),
    lostSalesPerUnitRisk: out.reduce((a, i) => a + i.price, 0),
    byBranch: Object.entries(byBranch).map(([branch, v]) => ({ branch, ...v })).sort((a, b) => (b.out + b.low) - (a.out + a.low)),
  };
}

/* ------------------------------------------------------------------ expiry */
async function expirySection(businessId, tz, today) {
  const todayMs = zonedMidnight(today, tz);
  const horizon = 30;
  const batches = await Batch.find({
    businessId: oid(businessId), status: 'active', quantity: { $gt: 0 },
    expiryDate: { $ne: null, $lt: new Date(todayMs + (horizon + 1) * DAY) },
  }).select('productId variantId branchId location batchNumber quantity costPrice expiryDate supplierId').sort({ expiryDate: 1 }).limit(5000).lean();

  const prods = await Product.find({ _id: { $in: [...new Set(batches.map((b) => String(b.productId)))] } }).select('name sku sellingPrice costPrice').lean();
  const pm = new Map(prods.map((p) => [String(p._id), p]));
  const varIds = batches.filter((b) => b.variantId).map((b) => b.variantId);
  const vars = varIds.length ? await ProductVariant.find({ _id: { $in: varIds } }).select('sku attributes sellingPrice costPrice').lean() : [];
  const vm = new Map(vars.map((v) => [String(v._id), v]));
  const [branches, sups] = await Promise.all([
    Branch.find({ businessId: oid(businessId) }).select('name').lean(),
    Supplier.find({ _id: { $in: [...new Set(batches.map((b) => b.supplierId).filter(Boolean).map(String))] } }).select('name').lean(),
  ]);
  const bn = new Map(branches.map((b) => [String(b._id), b.name])); const sn = new Map(sups.map((s) => [String(s._id), s.name]));

  const rows = batches.map((b) => {
    const p = pm.get(String(b.productId)) || {}; const v = b.variantId ? vm.get(String(b.variantId)) : null;
    const daysLeft = Math.round((new Date(b.expiryDate).getTime() - todayMs) / DAY);
    const cost = b.costPrice || (v && v.costPrice) || p.costPrice || 0;
    const price = (v && v.sellingPrice) || p.sellingPrice || 0;
    return {
      name: variantLabel(p.name || 'Product', v), sku: (v && v.sku) || p.sku || '', batchNumber: b.batchNumber, branch: bn.get(String(b.branchId)) || 'Branch',
      location: b.location === 'WAREHOUSE' ? 'Warehouse' : 'Shop floor', supplier: b.supplierId ? sn.get(String(b.supplierId)) || '' : '',
      quantity: b.quantity, expiryDate: b.expiryDate, daysLeft, cost, price, costValue: Math.round(b.quantity * cost), retailValue: Math.round(b.quantity * price),
    };
  });
  const bucket = (arr) => ({
    batches: arr.length, units: Math.round(arr.reduce((a, r) => a + r.quantity, 0) * 100) / 100,
    costValue: arr.reduce((a, r) => a + r.costValue, 0), retailValue: arr.reduce((a, r) => a + r.retailValue, 0),
    products: new Set(arr.map((r) => r.name)).size,
  });
  const expired = rows.filter((r) => r.daysLeft < 0).sort((a, b) => b.costValue - a.costValue);
  const thisWeek = rows.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 7).sort((a, b) => a.daysLeft - b.daysLeft || b.costValue - a.costValue);
  const later = rows.filter((r) => r.daysLeft > 7 && r.daysLeft <= horizon).sort((a, b) => a.daysLeft - b.daysLeft);
  const groupBy = (arr, key) => Object.values(arr.reduce((m, r) => { const g = m[r[key]] || (m[r[key]] = { [key]: r[key], batches: 0, costValue: 0, retailValue: 0 }); g.batches += 1; g.costValue += r.costValue; g.retailValue += r.retailValue; return m; }, {})).sort((a, b) => b.costValue - a.costValue);
  const atRisk = [...expired, ...thisWeek];
  const bands = [
    { label: 'Expired', value: bucket(expired).costValue, count: expired.length, tone: 'danger' },
    { label: '0-2 days', value: bucket(rows.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 2)).costValue, count: rows.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 2).length, tone: 'danger' },
    { label: '3-7 days', value: bucket(rows.filter((r) => r.daysLeft >= 3 && r.daysLeft <= 7)).costValue, count: rows.filter((r) => r.daysLeft >= 3 && r.daysLeft <= 7).length, tone: 'warning' },
    { label: '8-14 days', value: bucket(rows.filter((r) => r.daysLeft >= 8 && r.daysLeft <= 14)).costValue, count: rows.filter((r) => r.daysLeft >= 8 && r.daysLeft <= 14).length, tone: 'info' },
    { label: '15-30 days', value: bucket(rows.filter((r) => r.daysLeft >= 15 && r.daysLeft <= 30)).costValue, count: rows.filter((r) => r.daysLeft >= 15 && r.daysLeft <= 30).length, tone: 'info' },
  ];
  return {
    horizon, expired, thisWeek, later,
    totals: { expired: bucket(expired), thisWeek: bucket(thisWeek), later: bucket(later), atRisk: bucket(atRisk) },
    byBranch: groupBy(atRisk, 'branch'), bySupplier: groupBy(atRisk.filter((r) => r.supplier), 'supplier').slice(0, 8), bands,
    topLoss: [...atRisk].sort((a, b) => b.costValue - a.costValue).slice(0, 5),
    truncated: batches.length >= 5000,
  };
}

/** Everything for one business. */
async function collect(businessId, { now = Date.now() } = {}) {
  const business = await Business.findById(businessId).select('name email phone logo address town county').lean();
  if (!business) throw new Error('Business not found');
  const ctx = await getBusinessContext(businessId);
  const tz = ctx.timezone || 'Africa/Nairobi';
  const today = localDate(now, tz);
  const [sales, lowStock, expiry] = await Promise.all([salesSection(businessId, tz, today, ctx), lowStockSection(businessId), expirySection(businessId, tz, today)]);
  return {
    business: { id: String(business._id), name: business.name, email: business.email, phone: business.phone, address: [business.address, business.town, business.county].filter(Boolean).join(', ') },
    currency: ctx.currency, fmt: ctx.fmt, tz, generatedAt: new Date(now), today, sales, lowStock, expiry,
  };
}

module.exports = { collect, localDate, zonedMidnight, addDays, weekdayOf, WEEKDAYS };
