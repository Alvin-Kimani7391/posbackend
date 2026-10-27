/** Held (parked) sales: park a cart, serve the next customer, recall it later. Nothing is reserved; pricing happens again at the till. */
const HeldSale = require('../../models/HeldSale');
const Product = require('../../models/Product');
const ProductVariant = require('../../models/ProductVariant');
const BranchInventory = require('../../models/BranchInventory');
const Customer = require('../../models/Customer');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { hasPermission } = require('../../utils/permissionCheck');
const ApiError = require('../../utils/ApiError');
const { HELD_MAX_PER_CASHIER, HELD_TTL_HOURS } = require('../../constants/shop');

const canManage = (user) => hasPermission(user, 'shop.held.manage');

async function hold(businessId, user, { branchId, label, customerId, items, cartDiscount = 0, notes }) {
  assertBranchAccess(user, branchId);
  const count = await HeldSale.countDocuments({ businessId, cashierId: user._id, status: 'HELD' });
  if (count >= HELD_MAX_PER_CASHIER) throw ApiError.badRequest(`You already have ${HELD_MAX_PER_CASHIER} held sales. Recall or discard one first.`, 'TOO_MANY_HELD');
  if (customerId && !(await Customer.exists({ _id: customerId, businessId }))) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  const ids = [...new Set(items.map((i) => String(i.productId)))];
  const products = await Product.find({ _id: { $in: ids }, businessId, status: 'active' }).select('name');
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const lines = items.map((i) => {
    const p = byId.get(String(i.productId));
    if (!p) throw ApiError.badRequest('A product in this cart no longer exists', 'PRODUCT_NOT_FOUND');
    return { ...i, nameSnapshot: p.name };
  });
  const doc = await HeldSale.create({ businessId, branchId, cashierId: user._id, label, customerId, items: lines, cartDiscount, notes });
  return doc;
}

async function list(businessId, user, { branchId, mine } = {}) {
  const filter = { businessId, status: 'HELD' };
  if (branchId) { assertBranchAccess(user, branchId); filter.branchId = branchId; }
  else if (!canManage(user)) filter.branchId = { $in: user.branchIds || [] };
  if (!canManage(user) || mine) filter.cashierId = user._id;
  return HeldSale.find(filter).sort({ createdAt: -1 }).limit(100).populate('cashierId', 'name').populate('customerId', 'name phone');
}

async function load(businessId, user, id) {
  const doc = await HeldSale.findOne({ _id: id, businessId });
  if (!doc) throw ApiError.notFound('Held sale not found');
  assertBranchAccess(user, doc.branchId);
  if (String(doc.cashierId) !== String(user._id) && !canManage(user)) throw ApiError.forbidden('This held sale belongs to another cashier', 'HELD_NOT_YOURS');
  return doc;
}

/** Recall = hand the cart back to the till (once) with today's prices and stock so the cashier sees what changed. */
async function recall(businessId, user, id) {
  const peek = await load(businessId, user, id);
  if (peek.status !== 'HELD') throw ApiError.conflict('This held sale was already recalled or discarded', 'HELD_NOT_ACTIVE');
  const doc = await HeldSale.findOneAndUpdate({ _id: id, businessId, status: 'HELD' }, { $set: { status: 'RECALLED', recalledAt: new Date() } }, { new: true });
  if (!doc) throw ApiError.conflict('This held sale was just recalled on another till', 'HELD_NOT_ACTIVE');
  const pids = doc.items.map((i) => i.productId); const vids = doc.items.map((i) => i.variantId).filter(Boolean);
  const [products, variants, stock] = await Promise.all([
    Product.find({ _id: { $in: pids }, businessId }).select('name sellingPrice status trackInventory unit taxRate'),
    vids.length ? ProductVariant.find({ _id: { $in: vids }, businessId }).select('sellingPrice status') : [],
    BranchInventory.find({ businessId, branchId: doc.branchId, productId: { $in: pids } }),
  ]);
  const P = new Map(products.map((p) => [String(p._id), p])); const V = new Map(variants.map((v) => [String(v._id), v]));
  const lines = doc.items.map((i) => {
    const p = P.get(String(i.productId)); const v = i.variantId ? V.get(String(i.variantId)) : null;
    const rows = stock.filter((s) => String(s.productId) === String(i.productId) && String(s.variantId || '') === String(i.variantId || ''));
    const available = rows.reduce((a, r) => a + (r.quantity - r.reservedQuantity), 0);
    const problems = [];
    if (!p || p.status !== 'active') problems.push('PRODUCT_UNAVAILABLE');
    if (v && v.status !== 'active') problems.push('VARIANT_UNAVAILABLE');
    if (p && p.trackInventory && available < i.quantity) problems.push('INSUFFICIENT_STOCK');
    return { productId: i.productId, variantId: i.variantId, unitId: i.unitId, name: p ? p.name : i.nameSnapshot, quantity: i.quantity, discount: i.discount / 100, note: i.note,
      currentUnitPrice: p ? (v ? v.sellingPrice : p.sellingPrice) / 100 : null, available: p && p.trackInventory ? available : null, problems };
  });
  return { id: doc._id, label: doc.label, customerId: doc.customerId, branchId: doc.branchId, cartDiscount: doc.cartDiscount / 100, notes: doc.notes, lines, hasProblems: lines.some((l) => l.problems.length) };
}

async function discard(businessId, user, id) {
  const doc = await load(businessId, user, id);
  if (doc.status !== 'HELD') throw ApiError.conflict('This held sale is not active', 'HELD_NOT_ACTIVE');
  doc.status = 'DISCARDED'; doc.discardedBy = user._id; await doc.save();
  return doc;
}

module.exports = { hold, list, recall, discard, TTL_HOURS: HELD_TTL_HOURS };
