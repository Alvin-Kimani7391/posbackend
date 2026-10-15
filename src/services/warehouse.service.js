const mongoose = require('mongoose');
const BranchInventory = require('../models/BranchInventory');
const WarehouseInventory = require('../models/WarehouseInventory');
const Warehouse = require('../models/Warehouse');
const LocationTransfer = require('../models/LocationTransfer');
const InventoryMovement = require('../models/InventoryMovement');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Branch = require('../models/Branch');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange, assertWarehouseEnabled } = require('./inventory.service');
const { resolveWarehouse, nextWarehouseCode } = require('./warehouse.resolver');
const batchService = require('./batch.service');
const serialService = require('./serial.service');
const { assertBranchAccess } = require('../utils/branchAccess');
const { resolveUnit, wholesaleFloorPerBase, evaluateRetailPrice, wholesaleUnitPrice, retailUnitPrice } = require('../utils/units');

const round3 = (n) => Math.round(n * 1000) / 1000;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const LOCS = ['RETAIL', 'WAREHOUSE'];

// ============================================================================================================
// WAREHOUSES (create, list, edit, default, deactivate)
// ============================================================================================================
async function stockSummaryByWarehouse(businessId, warehouseIds) {
  const rows = await WarehouseInventory.aggregate([
    { $match: { businessId: oid(businessId), warehouseId: { $in: warehouseIds.map(oid) }, quantity: { $ne: 0 } } },
    { $group: { _id: '$warehouseId', skus: { $sum: 1 }, units: { $sum: '$quantity' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

async function listWarehouses(businessId, user, { branchId, status, includeStock = true } = {}) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (status) filter.status = status;
  let items = await Warehouse.find(filter).populate('branchId', 'name code').populate('managerId', 'name').sort({ isDefault: -1, name: 1 });
  items = items.filter((w) => { try { assertBranchAccess(user, w.branchId?._id || w.branchId); return true; } catch { return false; } });
  const sums = includeStock ? await stockSummaryByWarehouse(businessId, items.map((w) => w._id)) : new Map();
  return { items: items.map((w) => ({ ...w.toObject(), stock: { skus: sums.get(String(w._id))?.skus || 0, units: round3(sums.get(String(w._id))?.units || 0) } })) };
}

async function getWarehouse(businessId, user, id) {
  const w = await Warehouse.findOne({ _id: id, businessId }).populate('branchId', 'name code').populate('managerId', 'name');
  if (!w) throw ApiError.notFound('Warehouse not found');
  assertBranchAccess(user, w.branchId?._id || w.branchId);
  const sums = await stockSummaryByWarehouse(businessId, [w._id]);
  return { ...w.toObject(), stock: { skus: sums.get(String(w._id))?.skus || 0, units: round3(sums.get(String(w._id))?.units || 0) } };
}

async function createWarehouse(businessId, user, data) {
  await assertWarehouseEnabled(businessId);
  if (!(await Branch.exists({ _id: data.branchId, businessId }))) throw ApiError.badRequest('Branch not found', 'INVALID_BRANCH');
  assertBranchAccess(user, data.branchId);
  const code = (data.code || (await nextWarehouseCode(businessId))).toUpperCase();
  const hasDefault = await Warehouse.exists({ businessId, branchId: data.branchId, isDefault: true, status: 'active' });
  try {
    const w = await Warehouse.create({
      businessId, branchId: data.branchId, name: data.name, code, address: data.address, phone: data.phone, notes: data.notes,
      managerId: data.managerId, allowSales: data.allowSales !== false, isDefault: !hasDefault, createdBy: user._id,
    });
    await AuditLog.create({ businessId, branchId: w.branchId, userId: user._id, action: 'warehouse.create', entityType: 'Warehouse', entityId: w._id, newValue: { name: w.name, code: w.code } });
    return w;
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(`A warehouse with code ${code} already exists`, 'DUPLICATE_WAREHOUSE_CODE');
    throw err;
  }
}

async function updateWarehouse(businessId, user, id, data) {
  const w = await Warehouse.findOne({ _id: id, businessId });
  if (!w) throw ApiError.notFound('Warehouse not found');
  assertBranchAccess(user, w.branchId);
  if (data.status === 'inactive' && w.status !== 'inactive') await assertCanDeactivate(businessId, w);
  for (const k of ['name', 'address', 'phone', 'notes', 'managerId', 'allowSales', 'status']) if (data[k] !== undefined) w[k] = data[k];
  w.updatedBy = user._id;
  if (data.isDefault === true && !w.isDefault) {
    if (w.status !== 'active') throw ApiError.badRequest('An inactive warehouse cannot be the default', 'WAREHOUSE_INACTIVE');
    await Warehouse.updateMany({ businessId, branchId: w.branchId, isDefault: true }, { $set: { isDefault: false } });
    w.isDefault = true;
  }
  await w.save();
  await AuditLog.create({ businessId, branchId: w.branchId, userId: user._id, action: 'warehouse.update', entityType: 'Warehouse', entityId: w._id, newValue: data });
  return w;
}

async function assertCanDeactivate(businessId, w) {
  if (w.isDefault) throw ApiError.conflict('Make another warehouse the default first', 'DEFAULT_WAREHOUSE');
  const left = await WarehouseInventory.exists({ businessId, warehouseId: w._id, quantity: { $ne: 0 } });
  if (left) throw ApiError.conflict('This warehouse still holds stock. Move it to another warehouse first.', 'WAREHOUSE_NOT_EMPTY');
}

/** Warehouse stock of ONE warehouse (or all of a branch) - base units plus the same quantity expressed in each unit. */
async function listWarehouseInventory(businessId, branchId, { page = 1, limit = 20, search, lowStockOnly, outOfStockOnly, warehouseId } = {}) {
  await assertWarehouseEnabled(businessId);
  const filter = { businessId };
  if (warehouseId) filter.warehouseId = warehouseId; else filter.branchId = branchId;
  if (outOfStockOnly) filter.quantity = { $lte: 0 };
  let rows = await WarehouseInventory.find(filter).populate('productId', 'name sku barcode image unit units costPrice').populate('warehouseId', 'name code').sort({ updatedAt: -1 });
  if (search) {
    const re = new RegExp(escapeRe(search), 'i');
    rows = rows.filter((r) => re.test(r.productId?.name || '') || re.test(r.productId?.sku || ''));
  }
  if (lowStockOnly) rows = rows.filter((r) => r.quantity - r.reservedQuantity <= (r.lowStockThreshold ?? 5));
  const total = rows.length;
  const items = rows.slice((page - 1) * limit, page * limit).map((r) => {
    const o = r.toObject();
    o.inUnits = unitBreakdown(r.productId, r.quantity);
    return o;
  });
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

/** 53 packets with a bundle of 24 -> [{unit:'bundle', whole:2, remainder:5}, ...] (a quick "how many bundles" view). */
function unitBreakdown(product, baseQty) {
  return (product?.units || []).filter((u) => u.status !== 'inactive' && u.factor > 0)
    .map((u) => ({ unitId: u._id, unit: u.name, factor: u.factor, whole: Math.floor(round3(baseQty / u.factor)), remainderBase: round3(baseQty - Math.floor(round3(baseQty / u.factor)) * u.factor) }));
}

// ============================================================================================================
// TRANSFERS: warehouse -> retail ("sell to myself" with a new retail price), retail -> warehouse (return),
// warehouse -> warehouse. Every line may be entered in any unit of the product (2 bundles -> 48 packets).
// ============================================================================================================
async function transferBetweenLocations(businessId, user, { branchId, fromLocation, toLocation, fromWarehouseId, toWarehouseId, items, notes }) {
  const userId = user._id;
  if (!LOCS.includes(fromLocation) || !LOCS.includes(toLocation) || (fromLocation === 'RETAIL' && toLocation === 'RETAIL')) {
    throw ApiError.badRequest('Choose a source and a destination (RETAIL / WAREHOUSE)', 'INVALID_TRANSFER');
  }
  await assertWarehouseEnabled(businessId);

  // Resolve both ends. A retail end is the shop floor of the warehouse's branch (or of branchId).
  const src = fromLocation === 'WAREHOUSE' ? await resolveWarehouse(businessId, { warehouseId: fromWarehouseId, branchId, userId }) : null;
  const dst = toLocation === 'WAREHOUSE' ? await resolveWarehouse(businessId, { warehouseId: toWarehouseId, branchId: branchId || src?.branchId, userId }) : null;
  if (src && dst && String(src._id) === String(dst._id)) throw ApiError.badRequest('Source and destination warehouse are the same', 'INVALID_TRANSFER');

  const srcBranchId = src ? src.branchId : branchId;
  const dstBranchId = dst ? dst.branchId : branchId;
  if (!srcBranchId || !dstBranchId) throw ApiError.badRequest('branchId is required', 'INVALID_TRANSFER');
  if (!(await Branch.exists({ _id: srcBranchId, businessId })) || !(await Branch.exists({ _id: dstBranchId, businessId }))) throw ApiError.badRequest('Branch not found', 'INVALID_TRANSFER');
  assertBranchAccess(user, srcBranchId);
  assertBranchAccess(user, dstBranchId);
  const sameBranch = String(srcBranchId) === String(dstBranchId);
  if ((fromLocation === 'RETAIL' || toLocation === 'RETAIL') && !sameBranch) {
    throw ApiError.badRequest('The warehouse belongs to a different branch than the shop floor. Move warehouse -> warehouse, or use a branch stock transfer.', 'INVALID_TRANSFER');
  }
  const kind = fromLocation === 'WAREHOUSE' && toLocation === 'RETAIL' ? 'TO_RETAIL' : fromLocation === 'RETAIL' ? 'TO_WAREHOUSE' : 'WAREHOUSE_TO_WAREHOUSE';

  const transferId = new mongoose.Types.ObjectId();
  const seq = await nextSequence(businessId, 'locationTransfer:business', undefined);
  const transferNumber = `LT-${pad(seq)}`;

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const biz = await Business.findById(businessId).select('featureSettings wholesaleSettings').session(session);
      const strictBatches = !!biz?.featureSettings?.batchTracking;
      if (kind === 'TO_RETAIL' && biz?.wholesaleSettings?.allowRetailFromWarehouse === false) {
        throw ApiError.forbidden('Moving warehouse stock to retail is switched off in the wholesale settings', 'RETAIL_TRANSFER_DISABLED');
      }
      const doc = [];

      for (const line of items) {
        const product = await Product.findOne({ _id: line.productId, businessId }).session(session);
        if (!product) throw ApiError.notFound('Product not found');
        if (!product.trackInventory) throw ApiError.badRequest(`${product.name} does not track inventory, so it has no stock to move`, 'NOT_TRACKED');
        const variantId = line.variantId || null;
        if (product.hasVariants && !variantId) throw ApiError.badRequest(`${product.name} requires a variant`, 'VARIANT_REQUIRED');
        const variant = variantId ? await ProductVariant.findOne({ _id: variantId, businessId, productId: product._id }).session(session) : null;
        if (variantId && !variant) throw ApiError.badRequest('Variant not found', 'VARIANT_NOT_FOUND');

        // ---- unit conversion: "2 bundles" -> 48 base units. Stock and the ledger only ever hold base units. ----
        const unit = resolveUnit(product, line.unitId);
        if (!unit.isBase && !biz?.featureSettings?.unitConversions) throw ApiError.forbidden('Unit conversion is not enabled for your business', 'FEATURE_DISABLED');
        const enteredQty = round3(line.quantity);
        const qty = round3(enteredQty * unit.factor);
        if (qty <= 0) throw ApiError.badRequest('Quantity must be greater than zero', 'INVALID_QUANTITY');
        if (product.trackSerialNumber && !Number.isInteger(qty)) throw ApiError.badRequest(`${product.name}: serial-tracked units must be whole numbers`, 'INVALID_QUANTITY');
        if (kind === 'WAREHOUSE_TO_WAREHOUSE' && !sameBranch && (product.trackBatch || product.trackSerialNumber)) {
          throw ApiError.badRequest(`${product.name} is batch/serial tracked: warehouse-to-warehouse moves across branches are not supported for it`, 'INVALID_TRANSFER');
        }
        if (kind === 'WAREHOUSE_TO_WAREHOUSE' && product.trackSerialNumber) {
          throw ApiError.badRequest(`${product.name} is serial-tracked: serial units stay in their branch warehouse pool`, 'INVALID_TRANSFER');
        }

        const unitCostPerBase = variant ? variant.costPrice : product.costPrice;

        // ---- warehouse -> retail: the owner sells to himself, so he sets the new RETAIL price (per base unit) ----
        let pricing = null;
        if (kind === 'TO_RETAIL') {
          const floor = wholesaleFloorPerBase(product, variant);
          const existing = variant ? variant.sellingPrice : product.sellingPrice;
          pricing = evaluateRetailPrice({ requestedCents: line.retailPrice, existingCents: existing, wholesaleFloor: floor, costCents: unitCostPerBase });
          if (pricing.error) throw ApiError.badRequest(`${product.name}: ${pricing.error.message}`, pricing.error.code);
          if (pricing.changed) {
            if (variant) { variant.sellingPrice = pricing.priceCents; await variant.save({ session }); } else { product.sellingPrice = pricing.priceCents; await product.save({ session }); }
          }
          pricing.previous = existing;
        }

        const ref = { referenceType: 'LocationTransfer', referenceId: transferId, performedBy: userId, session };
        const label = (loc, wh) => (loc === 'WAREHOUSE' ? `warehouse ${wh.name}` : 'retail');
        const reason = `${transferNumber}: ${label(fromLocation, src)} -> ${label(toLocation, dst)}${notes ? ` (${notes})` : ''}`;

        // 1) books: out of the source pool, into the destination pool
        await applyStockChange({ businessId, branchId: srcBranchId, productId: product._id, variantId, quantityDelta: -qty, type: 'TRANSFER_OUT', reason, location: fromLocation, warehouseId: src?._id || null, ...ref });
        await applyStockChange({ businessId, branchId: dstBranchId, productId: product._id, variantId, quantityDelta: qty, type: 'TRANSFER_IN', reason, location: toLocation, warehouseId: dst?._id || null, ...ref });

        // 2) batches follow the stock (batches are pooled per branch: RETAIL or WAREHOUSE)
        let batchAllocations = [];
        if (product.trackBatch && kind !== 'WAREHOUSE_TO_WAREHOUSE') {
          batchAllocations = await batchService.moveBetweenLocations({
            businessId, branchId: srcBranchId, product, variantId, quantity: qty, from: fromLocation, to: toLocation,
            requestedBatchId: line.batchId || null, allowUnbatchedRemainder: !strictBatches, session,
          });
        }

        // 3) serial units follow the stock
        let serialNumbers = [];
        if (product.trackSerialNumber) {
          if (!line.serialNumbers?.length) throw ApiError.badRequest(`${product.name}: give the serial number(s) / IMEI(s) of the ${qty} unit(s) to move`, 'SERIAL_DETAILS_REQUIRED');
          serialNumbers = await serialService.moveLocation({
            businessId, branchId: srcBranchId, product, variantId, serials: line.serialNumbers, quantity: qty,
            from: fromLocation, to: toLocation, userId, refId: transferId, session,
          });
        }

        doc.push({
          productId: product._id, variantId, nameSnapshot: product.name, quantity: qty,
          unitId: unit.id || undefined, unitName: unit.name, unitFactor: unit.factor, enteredQuantity: enteredQty, baseUnitName: product.unit,
          unitCostCents: unitCostPerBase,
          ...(pricing ? { retailPriceCents: pricing.priceCents, previousRetailPriceCents: pricing.previous, priceFloorCents: Math.round(pricing.floorCents), priceFloorKind: pricing.floorKind, expectedProfitPerUnitCents: pricing.priceCents - unitCostPerBase } : {}),
          batchAllocations: batchAllocations.map((a) => ({ batchId: a.batchId, batchNumber: a.batchNumber, expiryDate: a.expiryDate, quantity: a.quantity })),
          serialNumbers,
        });
      }

      const [transfer] = await LocationTransfer.create([{
        _id: transferId, businessId, branchId: srcBranchId, transferNumber, kind, fromLocation, toLocation,
        from: { location: fromLocation, branchId: srcBranchId, warehouseId: src?._id, warehouseName: src?.name },
        to: { location: toLocation, branchId: dstBranchId, warehouseId: dst?._id, warehouseName: dst?.name },
        items: doc, notes, performedBy: userId,
      }], { session });
      await AuditLog.create([{ businessId, branchId: srcBranchId, userId, action: 'warehouse.transfer', entityType: 'LocationTransfer', entityId: transfer._id, newValue: { transferNumber, kind, lines: doc.length } }], { session });
      result = transfer;
    });
    return result;
  } finally {
    session.endSession();
  }
}

async function listLocationTransfers(businessId, { branchId, fromLocation, kind, warehouseId, productId, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (fromLocation) filter.fromLocation = fromLocation;
  if (kind) filter.kind = kind;
  if (warehouseId) filter.$or = [{ 'from.warehouseId': warehouseId }, { 'to.warehouseId': warehouseId }];
  if (productId) filter['items.productId'] = productId;
  const [items, total] = await Promise.all([
    LocationTransfer.find(filter).populate('performedBy', 'name').populate('branchId', 'name code').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    LocationTransfer.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getLocationTransfer(businessId, id) {
  const t = await LocationTransfer.findOne({ _id: id, businessId }).populate('performedBy', 'name').populate('branchId', 'name code').populate('items.productId', 'name sku');
  if (!t) throw ApiError.notFound('Transfer not found');
  return t;
}

// ============================================================================================================
// WAREHOUSE STOCK ADJUSTMENT (opening stock, damage, count corrections) in a chosen warehouse and unit
// ============================================================================================================
async function adjustWarehouseStock(businessId, user, warehouseId, { productId, variantId = null, quantity, unitId, type, reason, costPrice }) {
  const wh = await resolveWarehouse(businessId, { warehouseId, userId: user._id });
  assertBranchAccess(user, wh.branchId);
  const product = await Product.findOne({ _id: productId, businessId });
  if (!product) throw ApiError.notFound('Product not found');
  if (!product.trackInventory) throw ApiError.badRequest(`${product.name} does not track inventory`, 'NOT_TRACKED');
  if (product.trackSerialNumber || product.trackBatch) throw ApiError.badRequest(`${product.name} is batch/serial tracked: receive it with its batch or serial details`, 'USE_RECEIVE');
  const unit = resolveUnit(product, unitId);
  const delta = round3(quantity * unit.factor);
  if (!delta) throw ApiError.badRequest('Quantity cannot be zero', 'INVALID_QUANTITY');
  const mType = type || (delta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT');
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await applyStockChange({
        businessId, branchId: wh.branchId, productId, variantId, quantityDelta: delta, type: mType, referenceType: 'WarehouseAdjustment', referenceId: wh._id,
        reason: reason || `Warehouse ${wh.name} adjustment`, performedBy: user._id, session, location: 'WAREHOUSE', warehouseId: wh._id,
      });
      await AuditLog.create([{ businessId, branchId: wh.branchId, userId: user._id, action: 'warehouse.adjust', entityType: 'Warehouse', entityId: wh._id, newValue: { productId, delta, type: mType, reason } }], { session });
    });
    return { quantity: result.branchInventory.quantity, movement: result.movement };
  } finally {
    session.endSession();
  }
}

// ============================================================================================================
// WHOLESALE SALE DASHBOARD FEED: sellable warehouse products with unit prices and stock per unit
// ============================================================================================================
async function wholesaleCatalog(businessId, user, { warehouseId, branchId, search, page = 1, limit = 30, inStockOnly = true }) {
  await assertWarehouseEnabled(businessId);
  const wh = await resolveWarehouse(businessId, { warehouseId, branchId, userId: user._id, forSale: true });
  assertBranchAccess(user, wh.branchId);
  const stock = await WarehouseInventory.find({ businessId, warehouseId: wh._id, ...(inStockOnly ? { quantity: { $gt: 0 } } : {}) }).lean();
  const ids = [...new Set(stock.map((s) => String(s.productId)))];
  const pf = { businessId, _id: { $in: ids }, status: 'active' };
  if (search) { const rx = new RegExp(escapeRe(search), 'i'); pf.$or = [{ name: rx }, { sku: rx }, { barcode: rx }, { 'units.barcode': rx }]; }
  const products = await Product.find(pf).sort({ name: 1 });
  const variants = await ProductVariant.find({ businessId, productId: { $in: products.map((p) => p._id) }, status: 'active' });
  const vById = new Map(variants.map((v) => [String(v._id), v]));
  const pById = new Map(products.map((p) => [String(p._id), p]));
  const rows = [];
  for (const s of stock) {
    const p = pById.get(String(s.productId));
    if (!p) continue;
    const v = s.variantId ? vById.get(String(s.variantId)) : null;
    const base = { _id: null, name: p.unit, factor: 1, isBase: true, unit: null };
    const units = [base, ...(p.units || []).filter((u) => u.status !== 'inactive').map((u) => ({ _id: u._id, name: u.name, factor: u.factor, isBase: false, unit: u }))];
    const available = s.quantity - s.reservedQuantity;
    rows.push({
      productId: p._id, variantId: v?._id || null, name: p.name, variantSku: v?.sku, sku: v?.sku || p.sku, barcode: v?.barcode || p.barcode, image: p.image,
      baseUnit: p.unit, quantity: round3(s.quantity), availableQuantity: round3(available),
      costPrice: v ? v.costPrice : p.costPrice, taxRate: p.taxRate || 0, trackSerialNumber: !!p.trackSerialNumber, trackBatch: !!p.trackBatch,
      units: units.map((u) => ({
        unitId: u._id, name: u.name, factor: u.factor, isBase: u.isBase, isDefault: !!u.unit?.isWholesaleDefault,
        wholesalePrice: wholesaleUnitPrice(p, v, { unit: u.unit, factor: u.factor }),
        retailPrice: retailUnitPrice(p, v, { unit: u.unit, factor: u.factor }),
        available: round3(available / u.factor),
      })),
    });
  }
  const total = rows.length;
  return { warehouse: { _id: wh._id, name: wh.name, code: wh.code }, items: rows.slice((page - 1) * limit, page * limit), total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

/** Customisable wholesale dashboard settings (default mode, default warehouse, payment terms...). */
async function getWholesaleSettings(businessId) {
  const b = await Business.findById(businessId).select('wholesaleSettings featureSettings').lean();
  return { ...(b?.wholesaleSettings || {}), features: { multiWarehouse: !!b?.featureSettings?.multiWarehouse, unitConversions: !!b?.featureSettings?.unitConversions, wholesalePricing: !!b?.featureSettings?.wholesalePricing } };
}
async function updateWholesaleSettings(businessId, userId, data) {
  if (data.defaultWarehouseId) await resolveWarehouse(businessId, { warehouseId: data.defaultWarehouseId });
  const $set = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) $set[`wholesaleSettings.${k}`] = v;
  await Business.updateOne({ _id: businessId }, { $set });
  await AuditLog.create({ businessId, userId, action: 'wholesale.settings', entityType: 'Business', entityId: businessId, newValue: data });
  return getWholesaleSettings(businessId);
}

/** One row per product/variant with retail + warehouse (per warehouse) + total (the "books" view). */
async function stockOverview(businessId, branchId, { page = 1, limit = 20, search, warehouseId } = {}) {
  const whFilter = warehouseId ? { businessId, warehouseId } : { businessId, branchId };
  const [retail, warehouse] = await Promise.all([BranchInventory.find({ businessId, branchId }).lean(), WarehouseInventory.find(whFilter).lean()]);
  const map = new Map();
  const key = (r) => `${r.productId}:${r.variantId || ''}`;
  const slot = (r) => {
    if (!map.has(key(r))) map.set(key(r), { productId: r.productId, variantId: r.variantId || null, retailQuantity: 0, warehouseQuantity: 0, warehouses: [] });
    return map.get(key(r));
  };
  retail.forEach((r) => { slot(r).retailQuantity = r.quantity; });
  warehouse.forEach((r) => { const s = slot(r); s.warehouseQuantity = round3(s.warehouseQuantity + r.quantity); s.warehouses.push({ warehouseId: r.warehouseId || null, quantity: r.quantity }); });
  let rows = [...map.values()];
  const products = await Product.find({ businessId, _id: { $in: [...new Set(rows.map((r) => String(r.productId)))] } }).select('name sku costPrice unit units').lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  rows = rows.map((r) => {
    const p = byId.get(String(r.productId));
    return { ...r, name: p?.name, sku: p?.sku, baseUnit: p?.unit, totalQuantity: round3(r.retailQuantity + r.warehouseQuantity), costPrice: p?.costPrice || 0 };
  });
  if (search) { const re = new RegExp(escapeRe(search), 'i'); rows = rows.filter((r) => re.test(r.name || '') || re.test(r.sku || '')); }
  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const totals = rows.reduce((t, r) => ({
    retailUnits: t.retailUnits + r.retailQuantity, warehouseUnits: t.warehouseUnits + r.warehouseQuantity,
    retailCostValue: t.retailCostValue + r.retailQuantity * r.costPrice, warehouseCostValue: t.warehouseCostValue + r.warehouseQuantity * r.costPrice,
  }), { retailUnits: 0, warehouseUnits: 0, retailCostValue: 0, warehouseCostValue: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round3(totals[k]); });
  const total = rows.length;
  return { items: rows.slice((page - 1) * limit, page * limit), totals, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

/** Ledger vs stock rows, per pool (retail, and each warehouse). Differences are reported. */
async function reconcile(businessId, branchId) {
  const sums = await InventoryMovement.aggregate([
    { $match: { businessId: oid(businessId), branchId: oid(branchId) } },
    { $group: { _id: { productId: '$productId', variantId: '$variantId', location: { $cond: [{ $eq: ['$location', 'WAREHOUSE'] }, 'WAREHOUSE', 'RETAIL'] }, warehouseId: { $ifNull: ['$warehouseId', null] } }, ledger: { $sum: '$quantity' } } },
  ]);
  const [retail, warehouse] = await Promise.all([BranchInventory.find({ businessId, branchId }).lean(), WarehouseInventory.find({ businessId, branchId }).lean()]);
  const k = (loc, p, v, w) => `${loc}:${w || ''}:${p}:${v || ''}`;
  const actual = new Map();
  retail.forEach((r) => actual.set(k('RETAIL', r.productId, r.variantId, null), r.quantity));
  warehouse.forEach((r) => actual.set(k('WAREHOUSE', r.productId, r.variantId, r.warehouseId), r.quantity));
  // older ledger rows carry no warehouseId: fold them into whichever single warehouse row exists for that product
  const seen = new Set();
  const differences = [];
  for (const s of sums) {
    const key = k(s._id.location, s._id.productId, s._id.variantId, s._id.warehouseId);
    seen.add(key);
    const have = actual.get(key) || 0;
    if (round3(have - s.ledger) !== 0) differences.push({ location: s._id.location, warehouseId: s._id.warehouseId, productId: s._id.productId, variantId: s._id.variantId || null, ledger: round3(s.ledger), stock: have, difference: round3(have - s.ledger) });
  }
  for (const [key, qty] of actual) {
    if (!seen.has(key) && qty !== 0) {
      const [location, warehouseId, productId, variantId] = key.split(':');
      differences.push({ location, warehouseId: warehouseId || null, productId, variantId: variantId || null, ledger: 0, stock: qty, difference: qty });
    }
  }
  return { ok: differences.length === 0, differences };
}

module.exports = {
  listWarehouses, getWarehouse, createWarehouse, updateWarehouse,
  transferBetweenLocations, listLocationTransfers, getLocationTransfer,
  listWarehouseInventory, adjustWarehouseStock, wholesaleCatalog, getWholesaleSettings, updateWholesaleSettings, stockOverview, reconcile,
};
