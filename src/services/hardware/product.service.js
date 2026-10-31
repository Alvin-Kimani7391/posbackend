/** Hardware product facts, contractor prices, price quotes, shelf/bin locations, pick lists, remnant write-offs, projects, settings. Money = integer cents. */
const Product = require('../../models/Product');
const ProductVariant = require('../../models/ProductVariant');
const Customer = require('../../models/Customer');
const BranchInventory = require('../../models/BranchInventory');
const HardwareProfile = require('../../models/HardwareProfile');
const HardwareSettings = require('../../models/HardwareSettings');
const ContractorPrice = require('../../models/ContractorPrice');
const WarehouseLocation = require('../../models/WarehouseLocation');
const Project = require('../../models/Project');
const AuditLog = require('../../models/AuditLog');
const { applyStockChange } = require('../inventory.service');
const withTx = require('../../utils/withTx');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { resolveUnit } = require('../../utils/units');
const { fromCents } = require('../../utils/money');
const { bestPrice, checkQuantity } = require('./hardware-rules.service');
const templateSvc = require('./template.service');
const HardwareTemplate = require('../../models/HardwareTemplate');
const Supplier = require('../../models/Supplier');
const ApiError = require('../../utils/ApiError');

const clean = (o) => { Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]); return o; };
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dup = (e, msg, code) => { if (e.code === 11000) throw ApiError.conflict(msg, code); if (e.name === 'ValidationError') throw ApiError.badRequest(e.message.replace(/^.*?: /, ''), 'INVALID'); throw e; };

// ---------- settings ----------
async function getSettings(businessId) { return (await HardwareSettings.findOne({ businessId })) || HardwareSettings.findOneAndUpdate({ businessId }, { $setOnInsert: { businessId } }, { upsert: true, new: true }); }
async function updateSettings(businessId, user, input) { const s = await getSettings(businessId); Object.assign(s, clean({ ...input }), { updatedBy: user._id }); await s.save(); await AuditLog.create({ businessId, userId: user._id, action: 'hardware.settings.update', entityType: 'HardwareSettings', entityId: s._id, newValue: input }); return s; }

// ---------- product profile ----------
async function saveProfile(businessId, user, productId, input) {
  const product = await Product.findOne({ _id: productId, businessId }).select('name barcode trackInventory');
  if (!product) throw ApiError.notFound('Product not found');
  const existing = await HardwareProfile.findOne({ businessId, productId }).lean();
  await templateSvc.checkProfileRules(businessId, productId, product, input, existing);
  if (input.attributes) { const tid = input.templateId || existing?.templateId; if (!tid) throw ApiError.badRequest('Choose a template before setting attributes', 'TEMPLATE_REQUIRED'); const t = await HardwareTemplate.findOne({ _id: tid, businessId }); if (!t) throw ApiError.badRequest('Template not found', 'TEMPLATE_NOT_FOUND'); input.attributes = templateSvc.validateAttributes(t, input.attributes); }
  else if (input.templateId && !(await HardwareTemplate.exists({ _id: input.templateId, businessId }))) throw ApiError.badRequest('Template not found', 'TEMPLATE_NOT_FOUND');
  if (input.preferredSupplierId && !(await Supplier.exists({ _id: input.preferredSupplierId, businessId }))) throw ApiError.badRequest('Supplier not found', 'SUPPLIER_NOT_FOUND');
  if (input.bundle?.length) { const b = input.bundle.map((x) => String(x.productId)); if (b.includes(String(productId)) || new Set(b).size !== b.length || (await Product.countDocuments({ _id: { $in: b }, businessId })) !== b.length) throw ApiError.badRequest('Bundle items must be other, distinct products', 'INVALID_BUNDLE'); }
  if (input.minStock !== undefined && input.maxStock !== undefined && input.maxStock < input.minStock) throw ApiError.badRequest('Maximum stock is below minimum stock', 'INVALID_STOCK_LEVELS');
  const ids = [...(input.compatibleIds || []), ...(input.alternativeIds || [])];
  if (ids.some((i) => String(i) === String(productId))) throw ApiError.badRequest('A product cannot be its own alternative', 'SELF_REFERENCE');
  if (ids.length && (await Product.countDocuments({ _id: { $in: ids }, businessId })) !== new Set(ids.map(String)).size) throw ApiError.badRequest('A compatible / alternative product was not found', 'PRODUCT_NOT_FOUND');
  if (input.breaks) { const q = input.breaks.map((b) => b.minQty); if (new Set(q).size !== q.length) throw ApiError.badRequest('Two price breaks have the same quantity', 'DUPLICATE_BREAK'); input.breaks = [...input.breaks].sort((a, b) => a.minQty - b.minQty); }
  if (input.locations?.length) { const l = await WarehouseLocation.countDocuments({ _id: { $in: input.locations.map((x) => x.locationId) }, businessId }); if (l !== new Set(input.locations.map((x) => String(x.locationId))).size) throw ApiError.badRequest('A location was not found', 'LOCATION_NOT_FOUND'); }
  const doc = (await HardwareProfile.findOne({ businessId, productId })) || new HardwareProfile({ businessId, productId });
  Object.assign(doc, clean({ ...input }));
  await doc.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'hardware.profile.save', entityType: 'HardwareProfile', entityId: doc._id });
  return doc;
}
async function getProfile(businessId, productId) {
  const d = await HardwareProfile.findOne({ businessId, productId }).populate('alternativeIds compatibleIds', 'name sku sellingPrice').populate('locations.locationId', 'code rack shelf bin');
  if (!d) throw ApiError.notFound('No hardware details on this product yet');
  return d;
}
async function listProfiles(businessId, { search, handling, page = 1, limit = 50 }) {
  const q = { businessId }; if (handling) q.handling = handling;
  if (search) { const r = new RegExp(esc(search), 'i'); const ids = (await Product.find({ businessId, $or: [{ name: r }, { sku: r }, { brand: r }, { barcode: r }] }).select('_id').limit(500)).map((p) => p._id); q.$or = [{ productId: { $in: ids } }, { manufacturer: r }, { supplierCode: r }, { specification: r }]; }
  const [rows, total] = await Promise.all([HardwareProfile.find(q).populate('productId', 'name sku unit sellingPrice').sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit), HardwareProfile.countDocuments(q)]);
  return { total, page, rows };
}
/** Alternatives and compatible items with what is on the shelf right now. */
async function alternatives(businessId, user, productId, { branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const p = await HardwareProfile.findOne({ businessId, productId }).lean(); if (!p) return { alternatives: [], compatible: [] };
  const ids = [...p.alternativeIds, ...p.compatibleIds];
  const [prods, inv] = await Promise.all([Product.find({ _id: { $in: ids }, businessId, status: 'active' }).select('name sku unit sellingPrice').lean(), BranchInventory.aggregate([{ $match: { businessId: prods0(businessId), productId: { $in: ids }, ...(branchId ? { branchId: prods0(branchId) } : {}) } }, { $group: { _id: '$productId', onHand: { $sum: '$quantity' }, reserved: { $sum: '$reservedQuantity' } } }])]);
  const S = new Map(inv.map((r) => [String(r._id), r.onHand - r.reserved])); const row = (x) => ({ productId: x._id, name: x.name, sku: x.sku, unit: x.unit, price: fromCents(x.sellingPrice), available: S.get(String(x._id)) || 0 });
  const by = new Map(prods.map((x) => [String(x._id), x]));
  return { alternatives: p.alternativeIds.map((i) => by.get(String(i))).filter(Boolean).map(row), compatible: p.compatibleIds.map((i) => by.get(String(i))).filter(Boolean).map(row) };
}
function prods0(id) { return new (require('mongoose').Types.ObjectId)(String(id)); }

// ---------- contractor prices ----------
async function listContractor(businessId, { customerId, productId }) {
  const q = { businessId }; if (customerId) q.customerId = customerId; if (productId) q.productId = productId;
  const rows = await ContractorPrice.find(q).populate('customerId', 'name phone').populate('productId', 'name sku').populate('categoryId', 'name').sort({ createdAt: -1 }).limit(500).lean();
  return rows.map((r) => ({ ...r, value: r.mode === 'FIXED' ? fromCents(r.value) : r.value }));
}
async function saveContractor(businessId, user, id, input) {
  if (!id && !(await Customer.exists({ _id: input.customerId, businessId }))) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  const doc = id ? await ContractorPrice.findOne({ _id: id, businessId }) : new ContractorPrice({ businessId, createdBy: user._id });
  if (!doc) throw ApiError.notFound('Contractor price not found');
  Object.assign(doc, clean({ ...input }));
  try { await doc.save(); } catch (e) { dup(e, 'Already exists', 'DUPLICATE'); }
  await AuditLog.create({ businessId, userId: user._id, action: id ? 'hardware.contractor.update' : 'hardware.contractor.create', entityType: 'ContractorPrice', entityId: doc._id, newValue: input });
  return doc;
}
async function removeContractor(businessId, user, id) {
  const d = await ContractorPrice.findOneAndDelete({ _id: id, businessId }); if (!d) throw ApiError.notFound('Contractor price not found');
  await AuditLog.create({ businessId, userId: user._id, action: 'hardware.contractor.delete', entityType: 'ContractorPrice', entityId: id }); return { removed: true };
}

/** Price one line the way the till will (contractor price, quantity break, whole-unit rules). Cents. */
async function resolveLinePrice(businessId, business, customerId, it) {
  const product = await Product.findOne({ _id: it.productId, businessId, status: 'active' }); if (!product) throw ApiError.badRequest('Product not found', 'PRODUCT_NOT_FOUND');
  const variant = it.variantId ? await ProductVariant.findOne({ _id: it.variantId, businessId, productId: product._id }) : null;
  if (!variant && product.hasVariants) throw ApiError.badRequest(`${product.name} needs a variant`, 'VARIANT_REQUIRED');
  const unit = resolveUnit(product, it.unitId); const baseQty = Math.round(it.quantity * unit.factor * 1000) / 1000;
  const profile = await HardwareProfile.findOne({ businessId, productId: product._id }).lean(); checkQuantity({ profile, product, unit, quantity: it.quantity });
  const perBase = variant ? variant.sellingPrice : product.sellingPrice;
  const list = unit.isBase ? perBase : (unit.unit.retailPrice || Math.round(perBase * unit.factor));
  const on = business.featureSettings?.contractorPricing;
  const contractor = customerId && on ? await ContractorPrice.find({ businessId, customerId, active: true, $or: [{ productId: product._id }, ...(product.categoryId ? [{ categoryId: product.categoryId }] : [])] }).lean() : [];
  const best = on ? bestPrice({ current: list, factor: unit.factor, baseQty, costPerBase: variant ? variant.costPrice : product.costPrice, listPerBase: perBase, breaks: profile?.breaks || [], contractor }) : null;
  return { product, variant, unit, baseQty, list, unitPrice: best === null ? list : best, priceType: best === null ? 'RETAIL' : 'CONTRACT' };
}

/** What would this customer pay? Same rules the till applies inside POST /sales. */
async function priceQuote(businessId, { customerId, items }) {
  const business = await require('../../models/Business').findById(businessId).select('featureSettings businessType');
  const out = [];
  for (const it of items) {
    const r = await resolveLinePrice(businessId, business, customerId, it);
    out.push({ productId: r.product._id, variantId: r.variant?._id, name: r.product.name, unitId: r.unit.id, unit: r.unit.name, quantity: it.quantity, baseQuantity: r.baseQty, listPrice: fromCents(r.list), unitPrice: fromCents(r.unitPrice), lineTotal: fromCents(Math.round(r.unitPrice * it.quantity)), priceType: r.priceType, saving: fromCents(Math.round((r.list - r.unitPrice) * it.quantity)) });
  }
  return { items: out, total: Math.round(out.reduce((s, r) => s + r.lineTotal * 100, 0)) / 100, note: 'Before tax and discounts. The till applies the same rules when you sell.' };
}

// ---------- locations ----------
async function listLocations(businessId, user, { branchId }) { if (branchId) assertBranchAccess(user, branchId); return WarehouseLocation.find({ businessId, ...(branchId ? { branchId } : {}) }).sort({ code: 1 }); }
async function saveLocation(businessId, user, id, input) {
  assertBranchAccess(user, input.branchId);
  const doc = id ? await WarehouseLocation.findOne({ _id: id, businessId }) : new WarehouseLocation({ businessId });
  if (!doc) throw ApiError.notFound('Location not found');
  Object.assign(doc, clean({ ...input }));
  try { await doc.save(); } catch (e) { dup(e, 'This branch already has a location with that code', 'DUPLICATE_CODE'); }
  return doc;
}
async function removeLocation(businessId, id) {
  if (await HardwareProfile.exists({ businessId, 'locations.locationId': id })) throw ApiError.conflict('Products are assigned to this location. Move them first, or mark it inactive.', 'LOCATION_IN_USE');
  const d = await WarehouseLocation.findOneAndDelete({ _id: id, businessId }); if (!d) throw ApiError.notFound('Location not found'); return { removed: true };
}
/** Items in walking order (by location code). Items with no location come last. */
async function pickList(businessId, user, { branchId, items }) {
  assertBranchAccess(user, branchId);
  const [prods, profs] = await Promise.all([Product.find({ _id: { $in: items.map((i) => i.productId) }, businessId }).select('name sku unit').lean(), HardwareProfile.find({ businessId, productId: { $in: items.map((i) => i.productId) } }).lean()]);
  const locs = await WarehouseLocation.find({ businessId, branchId }).lean(); const L = new Map(locs.map((l) => [String(l._id), l]));
  const P = new Map(prods.map((p) => [String(p._id), p])); const H = new Map(profs.map((p) => [String(p.productId), p]));
  const rows = items.map((i) => { const p = P.get(String(i.productId)); const h = H.get(String(i.productId)); const loc = (h?.locations || []).filter((x) => String(x.branchId) === String(branchId)).map((x) => L.get(String(x.locationId))).filter(Boolean)[0];
    return { productId: i.productId, variantId: i.variantId, name: p ? p.name : 'Unknown', sku: p?.sku, quantity: i.quantity, unit: i.unitName || p?.unit, location: loc ? loc.code : null, handling: h?.handling || [], weightKg: h?.weightKg ? Math.round(h.weightKg * i.quantity * 100) / 100 : null }; });
  rows.sort((a, b) => (a.location === null) - (b.location === null) || String(a.location).localeCompare(String(b.location), undefined, { numeric: true }));
  return { branchId, rows, totalWeightKg: Math.round(rows.reduce((s, r) => s + (r.weightKg || 0), 0) * 100) / 100, special: [...new Set(rows.flatMap((r) => r.handling))] };
}

// ---------- remnants / scrap ----------
/** Write off an unusable offcut, damaged or scrap stock. Quantity is in BASE units (metres, pieces...). */
async function writeOff(businessId, user, { branchId, productId, variantId, quantity, reason, note }) {
  assertBranchAccess(user, branchId);
  const product = await Product.findOne({ _id: productId, businessId }).select('name trackInventory');
  if (!product) throw ApiError.notFound('Product not found');
  const profile = await HardwareProfile.findOne({ businessId, productId }).lean();
  if (!profile?.measurable && !Number.isInteger(quantity)) throw ApiError.badRequest('This item is counted in whole units', 'WHOLE_QUANTITY_ONLY');
  return withTx(async (session) => {
    await applyStockChange({ businessId, branchId, productId, variantId: variantId || null, quantityDelta: -quantity, type: 'DAMAGE', referenceType: 'HardwareWriteOff', reason: `${reason}${note ? `: ${note}` : ''}`, performedBy: user._id, session });
    await AuditLog.create([{ businessId, branchId, userId: user._id, action: 'hardware.writeoff', entityType: 'Product', entityId: productId, newValue: { quantity, reason, note } }], { session });
    return { productId, quantity, reason };
  });
}

// ---------- projects ----------
async function saveProject(businessId, user, id, input) {
  if (!id && !(await Customer.exists({ _id: input.customerId, businessId }))) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  const doc = id ? await Project.findOne({ _id: id, businessId }) : new Project({ businessId, createdBy: user._id });
  if (!doc) throw ApiError.notFound('Project not found');
  if (id) delete input.customerId;
  Object.assign(doc, clean({ ...input }));
  try { await doc.save(); } catch (e) { dup(e, 'A project with this code exists', 'DUPLICATE_CODE'); }
  return doc;
}
async function listProjects(businessId, { customerId, status }) { const q = { businessId }; if (customerId) q.customerId = customerId; if (status) q.status = status; return Project.find(q).populate('customerId', 'name phone').sort({ createdAt: -1 }).limit(300); }

module.exports = { resolveLinePrice, getSettings, updateSettings, saveProfile, getProfile, listProfiles, alternatives, listContractor, saveContractor, removeContractor, priceQuote, listLocations, saveLocation, removeLocation, pickList, writeOff, saveProject, listProjects };
