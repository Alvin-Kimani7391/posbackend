/** Compliance and volume reports for a wines & spirits shop. Money out = decimal. */
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const LiquorDetails = require('../../models/LiquorDetails');
const Product = require('../../models/Product');
const AgeCheckLog = require('../../models/AgeCheckLog');
const AuditLog = require('../../models/AuditLog');
const settingsSvc = require('./settings.service');
const empties = require('./empties.service');
const { fromCents } = require('../../utils/money');
const { assertBranchAccess } = require('../../utils/branchAccess');

const oid = (x) => new mongoose.Types.ObjectId(String(x));

/** Volume, pure alcohol and revenue by category (or product) over a period. Excise is only what the owner typed into the product. */
async function sales(businessId, user, { from, to, branchId, groupBy = 'category' }) {
  if (branchId) assertBranchAccess(user, branchId);
  const m = { businessId: oid(businessId), saleStatus: 'COMPLETED', soldAt: { $gte: from, $lte: to } }; if (branchId) m.branchId = oid(branchId);
  const rows = await Sale.aggregate([{ $match: m }, { $unwind: '$items' }, { $group: { _id: '$items.productId', name: { $first: '$items.nameSnapshot' }, qty: { $sum: { $ifNull: ['$items.baseQuantity', '$items.quantity'] } }, revenue: { $sum: { $subtract: ['$items.total', '$items.taxAmount'] } }, cost: { $sum: { $multiply: ['$items.costPriceSnapshot', { $ifNull: ['$items.baseQuantity', '$items.quantity'] }] } } } }]);
  const details = await LiquorDetails.find({ businessId, productId: { $in: rows.map((r) => r._id) } }).lean();
  const D = new Map(details.map((d) => [String(d.productId), d]));
  const g = new Map();
  for (const r of rows) {
    const d = D.get(String(r._id)); const cat = d ? d.category : 'NOT_LIQUOR'; const key = groupBy === 'product' ? String(r._id) : cat;
    const litres = d && d.volumeMl ? (r.qty * d.volumeMl) / 1000 : 0; const pure = d && d.abv ? litres * (d.abv / 100) : 0; const excise = d && d.exciseCentsPerUnit ? r.qty * d.exciseCentsPerUnit : 0;
    const x = g.get(key) || { key, name: groupBy === 'product' ? r.name : cat, units: 0, litres: 0, pureAlcoholLitres: 0, revenue: 0, cost: 0, exciseIncluded: 0 };
    x.units += r.qty; x.litres += litres; x.pureAlcoholLitres += pure; x.revenue += r.revenue; x.cost += r.cost; x.exciseIncluded += excise; g.set(key, x);
  }
  const items = [...g.values()].sort((a, b) => b.revenue - a.revenue).map((x) => ({ ...x, litres: Math.round(x.litres * 100) / 100, pureAlcoholLitres: Math.round(x.pureAlcoholLitres * 100) / 100, revenue: fromCents(x.revenue), profit: fromCents(x.revenue - x.cost), exciseIncluded: fromCents(x.exciseIncluded) }));
  const tot = items.reduce((s, x) => ({ units: s.units + x.units, litres: s.litres + x.litres, pure: s.pure + x.pureAlcoholLitres, revenue: s.revenue + x.revenue, excise: s.excise + x.exciseIncluded }), { units: 0, litres: 0, pure: 0, revenue: 0, excise: 0 });
  return { groupBy, totals: { units: tot.units, litres: Math.round(tot.litres * 100) / 100, pureAlcoholLitres: Math.round(tot.pure * 100) / 100, revenue: Math.round(tot.revenue * 100) / 100, exciseIncluded: Math.round(tot.excise * 100) / 100 }, items,
    note: 'Litres use the volume on each product. Tot lines count their own millilitres. Excise is only what you entered per product; it is an estimate, not a return.' };
}

async function ageChecks(businessId, user, { from, to, outcome, branchId, page = 1, limit = 50 }) {
  if (branchId) assertBranchAccess(user, branchId);
  const q = { businessId, at: { $gte: from, $lte: to } }; if (outcome) q.outcome = outcome; if (branchId) q.branchId = branchId;
  const [rows, total, stats] = await Promise.all([
    AgeCheckLog.find(q).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).populate('cashierId', 'name').lean(), AgeCheckLog.countDocuments(q),
    AgeCheckLog.aggregate([{ $match: { businessId: oid(businessId), at: { $gte: from, $lte: to } } }, { $group: { _id: '$outcome', n: { $sum: 1 } } }]),
  ]);
  return { total, page, passed: (stats.find((s) => s._id === 'PASSED') || {}).n || 0, refused: (stats.find((s) => s._id === 'REFUSED') || {}).n || 0, checks: rows };
}

async function overrides(businessId, { from, to, page = 1, limit = 50 }) {
  const q = { businessId, action: 'liquor.override', createdAt: { $gte: from, $lte: to } };
  const [rows, total] = await Promise.all([AuditLog.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'name').lean(), AuditLog.countDocuments(q)]);
  return { total, page, overrides: rows.map((r) => ({ at: r.createdAt, by: r.userId && r.userId.name, saleId: r.entityId, ...(r.newValue || {}) })) };
}

/** One call for the owner's compliance dashboard. */
async function overview(businessId, user, { branchId } = {}) {
  const since = new Date(Date.now() - 30 * 86400000); const now = new Date();
  const [status, checks, ov, containers, missing] = await Promise.all([
    settingsSvc.status(businessId), ageChecks(businessId, user, { from: since, to: now, branchId, limit: 1 }), overrides(businessId, { from: since, to: now, limit: 1 }),
    empties.list(businessId),
    LiquorDetails.distinct('productId', { businessId }).then(async (have) => Product.countDocuments({ businessId, status: 'active', productType: { $ne: 'service' }, _id: { $nin: have } })),
  ]);
  const warnings = [...status.warnings];
  if (missing > 0) warnings.push({ code: 'PRODUCTS_WITHOUT_DETAILS', message: `${missing} active product(s) have no liquor details (ABV, volume). Alcohol rules only apply to products that do.` });
  return { ...status, warnings, last30Days: { ageChecksPassed: checks.passed, ageChecksRefused: checks.refused, overrides: ov.total }, containers: containers.map((c) => ({ id: c._id, name: c.name, withCustomers: c.withCustomers, emptiesOnHand: c.emptiesOnHand, owedToSuppliers: c.owedToSuppliers, depositHeld: c.depositHeld })), productsWithoutDetails: missing };
}

module.exports = { sales, ageChecks, overrides, overview };
