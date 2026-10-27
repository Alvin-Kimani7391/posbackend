/** Bulk price changes with preview, history and revert. Money is integer cents. Products with variants are skipped (their prices live on the variants). */
const Product = require('../../models/Product');
const PriceChangeBatch = require('../../models/PriceChangeBatch');
const AuditLog = require('../../models/AuditLog');
const { ROUNDING } = require('../../constants/shop');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');

function roundTo(cents, step) { return step ? Math.round(cents / step) * step : Math.round(cents); }

/** pure: the new price for one product under a rule */
function newPrice(p, rule) {
  const cur = p[rule.field] || 0;
  let next;
  if (rule.mode === 'PERCENT') next = cur * (1 + rule.value / 100);
  else if (rule.mode === 'AMOUNT') next = cur + rule.value;
  else if (rule.mode === 'MARGIN') { // sellingPrice = cost + margin% of cost
    if (rule.field !== 'sellingPrice') return null;
    if (!(p.costPrice > 0)) return null;
    next = p.costPrice * (1 + rule.value / 100);
  } else if (rule.mode === 'SET') next = rule.value;
  else return null;
  next = roundTo(next, ROUNDING[rule.rounding || 'NONE'] || 0);
  if (rule.endIn99 && next >= 100) next = Math.ceil(next / 100) * 100 - 1; // 12.34 -> 12.99, 12.00 -> 11.99
  return Math.max(0, next);
}

async function select(businessId, f) {
  const q = { businessId, status: 'active' };
  if (f.productIds?.length) q._id = { $in: f.productIds };
  if (f.categoryIds?.length) q.categoryId = { $in: f.categoryIds };
  if (f.brand) q.brand = f.brand;
  if (!f.productIds?.length && !f.categoryIds?.length && !f.brand && !f.all) throw ApiError.badRequest('Choose products, categories, a brand, or tick "all products"', 'NO_SELECTION');
  return Product.find(q).select('name sku costPrice sellingPrice hasVariants').limit(5000);
}

async function preview(businessId, { filter, rule }) {
  const products = await select(businessId, filter);
  const changes = []; let skipped = 0; let belowCost = 0;
  for (const p of products) {
    if (p.hasVariants) { skipped += 1; continue; }
    const to = newPrice(p, rule);
    if (to === null || to === p[rule.field]) { skipped += 1; continue; }
    const costAfter = rule.field === 'costPrice' ? to : p.costPrice; const sellAfter = rule.field === 'sellingPrice' ? to : p.sellingPrice;
    const warn = sellAfter < costAfter; if (warn) belowCost += 1;
    changes.push({ productId: p._id, name: p.name, sku: p.sku, from: fromCents(p[rule.field]), to: fromCents(to), belowCost: warn, _from: p[rule.field], _to: to });
  }
  return { matched: products.length, willChange: changes.length, skipped, belowCost, sample: changes.slice(0, 50).map(({ _from, _to, ...c }) => c), changes };
}

async function apply(businessId, user, { filter, rule, allowBelowCost = false }) {
  const pv = await preview(businessId, { filter, rule });
  if (!pv.willChange) throw ApiError.badRequest('No product would change', 'NOTHING_TO_CHANGE');
  if (pv.belowCost && !allowBelowCost) throw ApiError.badRequest(`${pv.belowCost} product(s) would sell below cost. Review them, or confirm to allow it.`, 'BELOW_COST');
  const items = pv.changes.map((c) => ({ productId: c.productId, name: c.name, from: c._from, to: c._to }));
  await Product.bulkWrite(items.map((i) => ({ updateOne: { filter: { _id: i.productId, businessId, [rule.field]: i.from }, update: { $set: { [rule.field]: i.to, updatedBy: user._id } } } })));
  const batch = await PriceChangeBatch.create({ businessId, source: 'BULK', field: rule.field, rule: { ...rule, filter }, summary: `${items.length} product(s): ${rule.mode} ${rule.value ?? ''}`, items, createdBy: user._id });
  await AuditLog.create({ businessId, userId: user._id, action: 'price.bulk_change', entityType: 'PriceChangeBatch', entityId: batch._id, newValue: { field: rule.field, count: items.length } });
  return { batchId: batch._id, changed: items.length, belowCost: pv.belowCost };
}

async function history(businessId, { page = 1, limit = 20 } = {}) {
  const [rows, total] = await Promise.all([
    PriceChangeBatch.find({ businessId }).select('-items').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('createdBy', 'name').lean(),
    PriceChangeBatch.countDocuments({ businessId }),
  ]);
  return { total, page, rows: rows.map((r) => ({ ...r, rule: undefined })) };
}
async function getBatch(businessId, id) {
  const b = await PriceChangeBatch.findOne({ _id: id, businessId }).lean();
  if (!b) throw ApiError.notFound('Price change not found');
  b.items = b.items.map((i) => ({ ...i, from: fromCents(i.from), to: fromCents(i.to) }));
  return b;
}

/** Revert only the products whose price is still what this change set (a later edit is never overwritten). */
async function revert(businessId, user, id) {
  const b = await PriceChangeBatch.findOneAndUpdate({ _id: id, businessId, status: 'APPLIED' }, { $set: { status: 'REVERTED', revertedAt: new Date(), revertedBy: user._id } }, { new: false });
  if (!b) throw ApiError.conflict('This price change was already reverted or does not exist', 'NOT_REVERTIBLE');
  const res = await Product.bulkWrite(b.items.map((i) => ({ updateOne: { filter: { _id: i.productId, businessId, [b.field]: i.to }, update: { $set: { [b.field]: i.from, updatedBy: user._id } } } })));
  const reverted = res.modifiedCount || 0;
  await AuditLog.create({ businessId, userId: user._id, action: 'price.revert', entityType: 'PriceChangeBatch', entityId: b._id, newValue: { reverted, kept: b.items.length - reverted } });
  return { reverted, keptBecauseEditedSince: b.items.length - reverted };
}

module.exports = { newPrice, preview: async (b, x) => { const r = await preview(b, x); delete r.changes; return r; }, apply, history, getBatch, revert };
