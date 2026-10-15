const mongoose = require('mongoose');
const BranchInventory = require('../models/BranchInventory');
const WarehouseInventory = require('../models/WarehouseInventory');
const LocationTransfer = require('../models/LocationTransfer');
const InventoryMovement = require('../models/InventoryMovement');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange, assertWarehouseEnabled, LOCATIONS } = require('./inventory.service');
const batchService = require('./batch.service');
const serialService = require('./serial.service');

const round3 = (n) => Math.round(n * 1000) / 1000;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/**
 * Move stock between the WAREHOUSE and the RETAIL floor of one branch (either direction), atomically.
 * Per line: ledger OUT of the source pool + ledger IN to the destination pool (same reference), the batches
 * (FEFO or the one picked) move to the destination pool, and serial/IMEI units are re-located and get a history
 * entry. A LocationTransfer document keeps the full record. Fails as a whole if anything is short.
 */
async function transferBetweenLocations(businessId, userId, { branchId, fromLocation, toLocation, items, notes }) {
  if (!LOCATIONS.includes(fromLocation) || !LOCATIONS.includes(toLocation) || fromLocation === toLocation) {
    throw ApiError.badRequest('Source and destination must be different (RETAIL / WAREHOUSE)', 'INVALID_TRANSFER');
  }
  await assertWarehouseEnabled(businessId);
  if (!(await Branch.exists({ _id: branchId, businessId }))) throw ApiError.badRequest('Branch not found', 'INVALID_TRANSFER');

  const transferId = new mongoose.Types.ObjectId();
  const seq = await nextSequence(businessId, 'locationTransfer:business', undefined);
  const transferNumber = `LT-${pad(seq)}`;

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const biz = await Business.findById(businessId).select('featureSettings').session(session);
      const strictBatches = !!biz?.featureSettings?.batchTracking;
      const doc = [];

      for (const line of items) {
        const product = await Product.findOne({ _id: line.productId, businessId }).session(session);
        if (!product) throw ApiError.notFound('Product not found');
        if (!product.trackInventory) throw ApiError.badRequest(`${product.name} does not track inventory, so it has no stock to move`, 'NOT_TRACKED');
        const variantId = line.variantId || null;
        if (product.hasVariants && !variantId) throw ApiError.badRequest(`${product.name} requires a variant`, 'VARIANT_REQUIRED');
        const qty = round3(line.quantity);
        if (qty <= 0) throw ApiError.badRequest('Quantity must be greater than zero', 'INVALID_QUANTITY');
        if (product.trackSerialNumber && !Number.isInteger(qty)) throw ApiError.badRequest(`${product.name}: serial-tracked units must be whole numbers`, 'INVALID_QUANTITY');

        const ref = { referenceType: 'LocationTransfer', referenceId: transferId, performedBy: userId, session };
        const reason = `${transferNumber}: ${fromLocation.toLowerCase()} -> ${toLocation.toLowerCase()}${notes ? ` (${notes})` : ''}`;

        // 1) books: out of the source pool, into the destination pool
        await applyStockChange({ businessId, branchId, productId: product._id, variantId, quantityDelta: -qty, type: 'TRANSFER_OUT', reason, location: fromLocation, ...ref });
        await applyStockChange({ businessId, branchId, productId: product._id, variantId, quantityDelta: qty, type: 'TRANSFER_IN', reason, location: toLocation, ...ref });

        // 2) batches follow the stock
        let batchAllocations = [];
        if (product.trackBatch) {
          batchAllocations = await batchService.moveBetweenLocations({
            businessId, branchId, product, variantId, quantity: qty, from: fromLocation, to: toLocation,
            requestedBatchId: line.batchId || null, allowUnbatchedRemainder: !strictBatches, session,
          });
        }

        // 3) serial units follow the stock
        let serialNumbers = [];
        if (product.trackSerialNumber) {
          if (!line.serialNumbers?.length) throw ApiError.badRequest(`${product.name}: give the serial number(s) / IMEI(s) of the ${qty} unit(s) to move`, 'SERIAL_DETAILS_REQUIRED');
          serialNumbers = await serialService.moveLocation({
            businessId, branchId, product, variantId, serials: line.serialNumbers, quantity: qty,
            from: fromLocation, to: toLocation, userId, refId: transferId, session,
          });
        }

        doc.push({
          productId: product._id, variantId, nameSnapshot: product.name, quantity: qty,
          unitCostCents: product.costPrice || 0,
          batchAllocations: batchAllocations.map((a) => ({ batchId: a.batchId, batchNumber: a.batchNumber, expiryDate: a.expiryDate, quantity: a.quantity })),
          serialNumbers,
        });
      }

      const [transfer] = await LocationTransfer.create(
        [{ _id: transferId, businessId, branchId, transferNumber, fromLocation, toLocation, items: doc, notes, performedBy: userId }], { session }
      );
      await AuditLog.create([{ businessId, branchId, userId, action: 'warehouse.transfer', entityType: 'LocationTransfer', entityId: transfer._id, newValue: { transferNumber, fromLocation, toLocation, lines: doc.length } }], { session });
      result = transfer;
    });
    return result;
  } finally {
    session.endSession();
  }
}

async function listLocationTransfers(businessId, { branchId, fromLocation, productId, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (fromLocation) filter.fromLocation = fromLocation;
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

/** Warehouse stock of one branch (same filters as the retail inventory list). */
async function listWarehouseInventory(businessId, branchId, { page = 1, limit = 20, search, lowStockOnly, outOfStockOnly }) {
  await assertWarehouseEnabled(businessId);
  const filter = { businessId, branchId };
  if (outOfStockOnly) filter.quantity = { $lte: 0 };
  let rows = await WarehouseInventory.find(filter).populate('productId', 'name sku barcode image').sort({ updatedAt: -1 });
  if (search) {
    const re = new RegExp(escapeRe(search), 'i');
    rows = rows.filter((r) => re.test(r.productId?.name || '') || re.test(r.productId?.sku || ''));
  }
  if (lowStockOnly) rows = rows.filter((r) => r.quantity - r.reservedQuantity <= (r.lowStockThreshold ?? 5));
  const total = rows.length;
  return { items: rows.slice((page - 1) * limit, page * limit), total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

/** One row per product/variant with warehouse + retail + total quantities (the "books" view). */
async function stockOverview(businessId, branchId, { page = 1, limit = 20, search }) {
  const [retail, warehouse] = await Promise.all([
    BranchInventory.find({ businessId, branchId }).lean(),
    WarehouseInventory.find({ businessId, branchId }).lean(),
  ]);
  const map = new Map();
  const key = (r) => `${r.productId}:${r.variantId || ''}`;
  const slot = (r) => {
    if (!map.has(key(r))) map.set(key(r), { productId: r.productId, variantId: r.variantId || null, retailQuantity: 0, warehouseQuantity: 0 });
    return map.get(key(r));
  };
  retail.forEach((r) => { slot(r).retailQuantity = r.quantity; });
  warehouse.forEach((r) => { slot(r).warehouseQuantity = r.quantity; });
  let rows = [...map.values()];

  const products = await Product.find({ businessId, _id: { $in: [...new Set(rows.map((r) => String(r.productId)))] } }).select('name sku costPrice').lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  rows = rows.map((r) => {
    const p = byId.get(String(r.productId));
    return { ...r, name: p?.name, sku: p?.sku, totalQuantity: round3(r.retailQuantity + r.warehouseQuantity), costPrice: p?.costPrice || 0 };
  });
  if (search) { const re = new RegExp(escapeRe(search), 'i'); rows = rows.filter((r) => re.test(r.name || '') || re.test(r.sku || '')); }
  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const totals = rows.reduce((t, r) => ({
    retailUnits: t.retailUnits + r.retailQuantity,
    warehouseUnits: t.warehouseUnits + r.warehouseQuantity,
    retailCostValue: t.retailCostValue + r.retailQuantity * r.costPrice,
    warehouseCostValue: t.warehouseCostValue + r.warehouseQuantity * r.costPrice,
  }), { retailUnits: 0, warehouseUnits: 0, retailCostValue: 0, warehouseCostValue: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round3(totals[k]); });

  const total = rows.length;
  return { items: rows.slice((page - 1) * limit, page * limit), totals, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

/**
 * Reconciliation: does the ledger agree with the stock rows? Per branch/product/pool, sum of movements should equal
 * the stock quantity. Differences are reported (rows with stock set before the ledger existed will show up here).
 */
async function reconcile(businessId, branchId) {
  const sums = await InventoryMovement.aggregate([
    { $match: { businessId: oid(businessId), branchId: oid(branchId) } },
    { $group: { _id: { productId: '$productId', variantId: '$variantId', location: { $cond: [{ $eq: ['$location', 'WAREHOUSE'] }, 'WAREHOUSE', 'RETAIL'] } }, ledger: { $sum: '$quantity' } } },
  ]);
  const [retail, warehouse] = await Promise.all([
    BranchInventory.find({ businessId, branchId }).lean(), WarehouseInventory.find({ businessId, branchId }).lean(),
  ]);
  const actual = new Map();
  retail.forEach((r) => actual.set(`RETAIL:${r.productId}:${r.variantId || ''}`, r.quantity));
  warehouse.forEach((r) => actual.set(`WAREHOUSE:${r.productId}:${r.variantId || ''}`, r.quantity));
  const seen = new Set();
  const differences = [];
  for (const s of sums) {
    const k = `${s._id.location}:${s._id.productId}:${s._id.variantId || ''}`;
    seen.add(k);
    const have = actual.get(k) || 0;
    if (round3(have - s.ledger) !== 0) differences.push({ location: s._id.location, productId: s._id.productId, variantId: s._id.variantId || null, ledger: round3(s.ledger), stock: have, difference: round3(have - s.ledger) });
  }
  for (const [k, qty] of actual) {
    if (!seen.has(k) && qty !== 0) {
      const [location, productId, variantId] = k.split(':');
      differences.push({ location, productId, variantId: variantId || null, ledger: 0, stock: qty, difference: qty });
    }
  }
  return { ok: differences.length === 0, differences };
}

module.exports = { transferBetweenLocations, listLocationTransfers, getLocationTransfer, listWarehouseInventory, stockOverview, reconcile };
