/** Liquor facts on products, and tot products made from a bottle. */
const LiquorDetails = require('../../models/LiquorDetails');
const Product = require('../../models/Product');
const ContainerType = require('../../models/ContainerType');
const AuditLog = require('../../models/AuditLog');
const productSvc = require('../product.service');
const { nextSequence, pad } = require('../../models/Counter');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');

const clean = (o) => { Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]); return o; };

async function assertRefs(businessId, productId, input) {
  const product = await Product.findOne({ _id: productId, businessId }).select('name');
  if (!product) throw ApiError.notFound('Product not found');
  if (input.containerTypeId && !(await ContainerType.exists({ _id: input.containerTypeId, businessId }))) throw ApiError.badRequest('Container type not found', 'CONTAINER_NOT_FOUND');
  if (input.tot && input.tot.bottleProductId) {
    if (String(input.tot.bottleProductId) === String(productId)) throw ApiError.badRequest('A tot product cannot draw from itself', 'INVALID_TOT');
    const bottle = await LiquorDetails.findOne({ businessId, productId: input.tot.bottleProductId });
    if (!bottle || !(bottle.volumeMl > 0)) throw ApiError.badRequest('The bottle product needs its volume (ml) set first', 'BOTTLE_VOLUME_MISSING');
    if (bottle.tot && bottle.tot.bottleProductId) throw ApiError.badRequest('The bottle product is itself a tot product', 'INVALID_TOT');
    if (input.tot.ml > bottle.volumeMl) throw ApiError.badRequest('A tot cannot be bigger than the bottle', 'INVALID_TOT');
  }
  return product;
}

async function upsert(businessId, user, productId, input) {
  await assertRefs(businessId, productId, input);
  const doc = (await LiquorDetails.findOne({ businessId, productId })) || new LiquorDetails({ businessId, productId });
  const fields = clean({ ...input }); const syncCost = fields.syncTotCost; delete fields.syncTotCost;
  if (fields.tot === null) { doc.tot = undefined; delete fields.tot; }
  if (fields.containerTypeId === null) { doc.containerTypeId = undefined; delete fields.containerTypeId; }
  Object.assign(doc, fields);
  try { await doc.save(); } catch (e) { if (e.name === 'ValidationError') throw ApiError.badRequest(e.message.replace(/^.*?: /, ''), 'INVALID_LIQUOR_DETAILS'); throw e; }
  if (syncCost && doc.tot && doc.tot.bottleProductId) await syncTotCost(businessId, user, productId);
  await AuditLog.create({ businessId, userId: user._id, action: 'liquor.details.upsert', entityType: 'LiquorDetails', entityId: doc._id, newValue: input });
  return doc;
}

/** cost of one tot = bottle cost x ml / bottle ml */
async function totCost(businessId, bottleProductId, ml) {
  const [bottle, d] = await Promise.all([Product.findOne({ _id: bottleProductId, businessId }).select('costPrice sellingPrice name'), LiquorDetails.findOne({ businessId, productId: bottleProductId })]);
  if (!bottle || !d || !d.volumeMl) throw ApiError.badRequest('The bottle product needs its volume (ml) set first', 'BOTTLE_VOLUME_MISSING');
  return { bottle, costPerTot: Math.round((bottle.costPrice * ml) / d.volumeMl), suggestedPrice: Math.round((bottle.sellingPrice * ml) / d.volumeMl), volumeMl: d.volumeMl, totsPerBottle: Math.floor(d.volumeMl / ml) };
}
async function syncTotCost(businessId, user, totProductId) {
  const d = await LiquorDetails.findOne({ businessId, productId: totProductId });
  if (!d || !d.tot || !d.tot.bottleProductId) throw ApiError.badRequest('This product is not a tot product', 'NOT_A_TOT');
  const { costPerTot } = await totCost(businessId, d.tot.bottleProductId, d.tot.ml);
  await Product.updateOne({ _id: totProductId, businessId }, { $set: { costPrice: costPerTot, updatedBy: user._id } });
  return costPerTot;
}

/** Make the tot product for a bottle: a normal product (no stock of its own) plus the link. price (when given) is integer cents, converted by the validator. */
async function createTotProduct(businessId, user, bottleProductId, { ml, price, name, barcode }) {
  const info = await totCost(businessId, bottleProductId, ml);
  const sellingPrice = price != null ? price : info.suggestedPrice; // cents when from suggestion, converted by caller when explicit
  const seq = await nextSequence(businessId, 'sku:business');
  const product = await productSvc.createProduct(businessId, user._id, clean({
    name: name || `${info.bottle.name} (tot ${ml}ml)`, sku: `TOT-${pad(seq, 6)}`, barcode, unit: 'piece', trackInventory: false, costPrice: info.costPerTot, sellingPrice,
    taxRate: (await Product.findById(bottleProductId).select('taxRate')).taxRate || 0, categoryId: (await Product.findById(bottleProductId).select('categoryId')).categoryId,
  }));
  const bottleDetails = await LiquorDetails.findOne({ businessId, productId: bottleProductId });
  await LiquorDetails.create({ businessId, productId: product._id, category: bottleDetails.category, isAlcohol: bottleDetails.isAlcohol, abv: bottleDetails.abv, volumeMl: ml, tot: { bottleProductId, ml } });
  await AuditLog.create({ businessId, userId: user._id, action: 'liquor.tot.create', entityType: 'Product', entityId: product._id, newValue: { bottleProductId, ml } });
  return { product, totsPerBottle: info.totsPerBottle, costPerTot: fromCents(info.costPerTot) };
}

async function get(businessId, productId) {
  const d = await LiquorDetails.findOne({ businessId, productId }).populate('containerTypeId', 'name deposit');
  if (!d) throw ApiError.notFound('No liquor details on this product yet');
  return d;
}

async function list(businessId, { category, alcoholOnly, search, page = 1, limit = 50, missing } = {}) {
  if (missing) { // products that have no liquor details yet: the set-up to-do list
    const have = await LiquorDetails.distinct('productId', { businessId });
    const q = { businessId, status: 'active', productType: { $ne: 'service' }, _id: { $nin: have } };
    if (search) q.name = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [rows, total] = await Promise.all([Product.find(q).select('name sku barcode unit sellingPrice').sort({ name: 1 }).skip((page - 1) * limit).limit(limit), Product.countDocuments(q)]);
    return { total, page, products: rows };
  }
  const q = { businessId }; if (category) q.category = category; if (alcoholOnly) q.isAlcohol = true;
  if (search) { const ids = await Product.find({ businessId, name: new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).select('_id').limit(500); q.productId = { $in: ids.map((p) => p._id) }; }
  const [rows, total] = await Promise.all([LiquorDetails.find(q).populate('productId', 'name sku barcode unit sellingPrice costPrice').skip((page - 1) * limit).limit(limit), LiquorDetails.countDocuments(q)]);
  return { total, page, items: rows };
}

async function remove(businessId, user, productId) {
  if (await LiquorDetails.exists({ businessId, 'tot.bottleProductId': productId })) throw ApiError.conflict('Tot products still draw from this bottle. Remove them first.', 'HAS_TOTS');
  const d = await LiquorDetails.findOneAndDelete({ businessId, productId });
  if (!d) throw ApiError.notFound('No liquor details on this product');
  await AuditLog.create({ businessId, userId: user._id, action: 'liquor.details.remove', entityType: 'LiquorDetails', entityId: d._id });
  return { removed: true };
}

module.exports = { upsert, get, list, remove, totCost, syncTotCost, createTotProduct };
