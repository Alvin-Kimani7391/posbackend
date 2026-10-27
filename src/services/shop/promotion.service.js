/** Dated offers. The till asks /quote for the discount each cart line earns; the cashier sends it as the line discount. Money is integer cents inside, decimal at the API. */
const Promotion = require('../../models/Promotion');
const Product = require('../../models/Product');
const ProductVariant = require('../../models/ProductVariant');
const Category = require('../../models/Category');
const Branch = require('../../models/Branch');
const AuditLog = require('../../models/AuditLog');
const { getBusinessContext } = require('../../utils/businessContext');
const { localDateTime, dowOf } = require('../../utils/hospitalityTime');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');

const isCents = (t) => t === 'AMOUNT_OFF' || t === 'FIXED_PRICE';
function present(p) {
  const o = p.toObject ? p.toObject() : { ...p };
  if (isCents(o.type) && o.value != null) o.value = fromCents(o.value);
  return o;
}

async function assertRefs(businessId, data) {
  if (data.productIds?.length) { const n = await Product.countDocuments({ _id: { $in: data.productIds }, businessId }); if (n !== new Set(data.productIds.map(String)).size) throw ApiError.badRequest('A selected product was not found', 'PRODUCT_NOT_FOUND'); }
  if (data.categoryIds?.length) { const n = await Category.countDocuments({ _id: { $in: data.categoryIds }, businessId }); if (n !== new Set(data.categoryIds.map(String)).size) throw ApiError.badRequest('A selected category was not found', 'CATEGORY_NOT_FOUND'); }
  if (data.branchIds?.length) { const n = await Branch.countDocuments({ _id: { $in: data.branchIds }, businessId }); if (n !== new Set(data.branchIds.map(String)).size) throw ApiError.badRequest('A selected branch was not found', 'BRANCH_NOT_FOUND'); }
}

async function create(businessId, user, data) {
  await assertRefs(businessId, data);
  try {
    const p = await Promotion.create({ ...data, businessId, createdBy: user._id });
    await AuditLog.create({ businessId, userId: user._id, action: 'promotion.create', entityType: 'Promotion', entityId: p._id, newValue: { name: p.name, type: p.type } });
    return present(p);
  } catch (e) { if (e.name === 'ValidationError') throw ApiError.badRequest(e.message.replace(/^.*?: /, ''), 'INVALID_PROMOTION'); throw e; }
}

async function update(businessId, user, id, data) {
  const p = await Promotion.findOne({ _id: id, businessId });
  if (!p) throw ApiError.notFound('Promotion not found');
  await assertRefs(businessId, data);
  Object.assign(p, data, { updatedBy: user._id });
  try { await p.save(); } catch (e) { if (e.name === 'ValidationError') throw ApiError.badRequest(e.message.replace(/^.*?: /, ''), 'INVALID_PROMOTION'); throw e; }
  await AuditLog.create({ businessId, userId: user._id, action: 'promotion.update', entityType: 'Promotion', entityId: p._id, newValue: data });
  return present(p);
}

async function setStatus(businessId, user, id, status) {
  const p = await Promotion.findOneAndUpdate({ _id: id, businessId }, { $set: { status, updatedBy: user._id } }, { new: true });
  if (!p) throw ApiError.notFound('Promotion not found');
  return present(p);
}
async function remove(businessId, user, id) {
  const p = await Promotion.findOneAndDelete({ _id: id, businessId });
  if (!p) throw ApiError.notFound('Promotion not found');
  await AuditLog.create({ businessId, userId: user._id, action: 'promotion.delete', entityType: 'Promotion', entityId: id, oldValue: { name: p.name } });
  return { deleted: true };
}
async function list(businessId, { state = 'all' } = {}) {
  const now = new Date(); const f = { businessId };
  if (state === 'active') Object.assign(f, { status: 'ACTIVE', startsAt: { $lte: now }, endsAt: { $gte: now } });
  else if (state === 'upcoming') Object.assign(f, { startsAt: { $gt: now } });
  else if (state === 'ended') Object.assign(f, { endsAt: { $lt: now } });
  return (await Promotion.find(f).sort({ startsAt: -1 }).limit(200)).map(present);
}
async function get(businessId, id) {
  const p = await Promotion.findOne({ _id: id, businessId });
  if (!p) throw ApiError.notFound('Promotion not found');
  return present(p);
}

function discountFor(promo, unitPrice, qty) {
  const gross = Math.round(unitPrice * qty);
  let d = 0;
  if (promo.type === 'PERCENT') d = Math.round(gross * promo.value / 100);
  else if (promo.type === 'AMOUNT_OFF') d = Math.round(promo.value * qty);
  else if (promo.type === 'FIXED_PRICE') d = unitPrice > promo.value ? Math.round((unitPrice - promo.value) * qty) : 0;
  else if (promo.type === 'MULTI_BUY') { const groups = Math.floor(qty / promo.buyQty); d = groups * (promo.buyQty - promo.payQty) * unitPrice; }
  return Math.max(0, Math.min(gross, d));
}
const appliesTo = (promo, product) => promo.scope === 'ALL'
  || (promo.scope === 'PRODUCTS' && promo.productIds.some((x) => String(x) === String(product._id)))
  || (promo.scope === 'CATEGORIES' && product.categoryId && promo.categoryIds.some((x) => String(x) === String(product.categoryId)));

/** Offers running right now for a branch (business time zone decides the date and weekday). */
async function activeNow(businessId, branchId, at = new Date()) {
  const ctx = await getBusinessContext(businessId);
  const dow = dowOf(localDateTime(at, ctx.timezone).ymd);
  const promos = await Promotion.find({ businessId, status: 'ACTIVE', startsAt: { $lte: at }, endsAt: { $gte: at } });
  return promos.filter((p) => (!p.branchIds.length || !branchId || p.branchIds.some((b) => String(b) === String(branchId))) && (!p.daysOfWeek.length || p.daysOfWeek.includes(dow)));
}

/** lines: [{ productId, variantId?, unitId?, quantity }] -> the best single offer per line (offers never stack). */
async function quote(businessId, { branchId, lines }) {
  const promos = await activeNow(businessId, branchId);
  const pids = [...new Set(lines.map((l) => String(l.productId)))];
  const vids = lines.map((l) => l.variantId).filter(Boolean);
  const [products, variants] = await Promise.all([
    Product.find({ _id: { $in: pids }, businessId }).select('name sellingPrice categoryId units defaultDiscount'),
    vids.length ? ProductVariant.find({ _id: { $in: vids }, businessId }).select('sellingPrice') : [],
  ]);
  const P = new Map(products.map((p) => [String(p._id), p])); const V = new Map(variants.map((v) => [String(v._id), v]));
  let total = 0;
  const out = lines.map((l) => {
    const p = P.get(String(l.productId));
    if (!p) throw ApiError.badRequest('Product not found', 'PRODUCT_NOT_FOUND');
    let unitPrice = l.variantId && V.get(String(l.variantId)) ? V.get(String(l.variantId)).sellingPrice : p.sellingPrice;
    if (l.unitId) { const u = (p.units || []).find((x) => String(x._id) === String(l.unitId)); if (u) unitPrice = u.retailPrice != null ? u.retailPrice : Math.round(p.sellingPrice * u.factor); }
    let best = null;
    for (const promo of promos) {
      if (!appliesTo(promo, p) || l.quantity < (promo.minQty || 0)) continue;
      const d = discountFor(promo, unitPrice, l.quantity);
      if (d > 0 && (!best || d > best.d)) best = { d, promo };
    }
    const standing = Math.min(Math.round(unitPrice * l.quantity), Math.round((p.defaultDiscount || 0) * l.quantity));
    const promoD = best ? best.d : 0;
    const suggested = Math.max(promoD, standing);
    total += suggested;
    return { productId: l.productId, variantId: l.variantId || null, name: p.name, quantity: l.quantity, unitPrice: fromCents(unitPrice), gross: fromCents(Math.round(unitPrice * l.quantity)),
      promoDiscount: fromCents(promoD), standingDiscount: fromCents(standing), suggestedDiscount: fromCents(suggested), source: suggested === 0 ? null : (promoD >= standing ? 'PROMOTION' : 'STANDING_DISCOUNT'),
      promotion: best ? { id: best.promo._id, name: best.promo.name, type: best.promo.type } : null };
  });
  return { lines: out, totalSuggestedDiscount: fromCents(total) };
}

module.exports = { create, update, setStatus, remove, list, get, activeNow, quote, discountFor, present };
