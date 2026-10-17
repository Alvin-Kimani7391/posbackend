const mongoose = require('mongoose');
const BranchInventory = require('../models/BranchInventory');
const WarehouseInventory = require('../models/WarehouseInventory');
const InventoryMovement = require('../models/InventoryMovement');
const Batch = require('../models/Batch');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');
const { resolveUnit, round3, unitBreakdown } = require('../utils/units');

/** Quantity entered in any unit of the product (2 bundles) -> BASE units (48 packets). Stock is always base units. */
async function toBaseQuantity(businessId, product, quantity, unitId) {
  const unit = resolveUnit(product, unitId);
  if (!unit.isBase) {
    const biz = await Business.findById(businessId).select('featureSettings').lean();
    if (!biz?.featureSettings?.unitConversions) throw ApiError.forbidden('Unit conversion is not enabled for your business', 'FEATURE_DISABLED');
    if (product.trackSerialNumber) throw ApiError.badRequest(`${product.name} is serial-tracked: enter units one by one`, 'SERIAL_BASE_ONLY');
  }
  return { quantity: round3(quantity * unit.factor), factor: unit.factor, unit };
}
const { resolveWarehouse } = require('./warehouse.resolver');

const LOCATIONS = ['RETAIL', 'WAREHOUSE'];
const inventoryModel = (location) => (location === 'WAREHOUSE' ? WarehouseInventory : BranchInventory);

/**
 * applyStockChange - THE single place that ever mutates BranchInventory.quantity.
 * Every module that touches stock (sales, purchases, refunds, transfers,
 * manual adjustments) goes through this function so there is exactly one
 * code path to get right for concurrency safety and movement logging.
 *
 * Concurrency: for a decrement without allowNegative, the update's filter
 * includes `quantity: { $gte: requiredAmount }`. MongoDB only applies an
 * update to a document matching its filter, and finds+updates atomically -
 * so if two concurrent requests both try to take the last unit, only one
 * findOneAndUpdate call can match and succeed; the other gets back null and
 * is rejected with INSUFFICIENT_STOCK. This is what prevents the
 * "Cashier A and B both sell the last unit" race from spec section 62.
 *
 * `location` picks the stock pool: 'RETAIL' (default = BranchInventory, everything that existed before) or
 * 'WAREHOUSE' (WarehouseInventory). Both use this one code path and write the same ledger, tagged with the
 * location, so every unit in either pool is traceable. A business can have SEVERAL warehouses: for
 * location 'WAREHOUSE' pass `warehouseId`; without it the branch's default warehouse is used.
 * quantityDelta is always in the product's BASE unit (see utils/units.js).
 *
 * MUST be called with an active mongoose session (the caller's transaction)
 * so the inventory update and its movement record commit or roll back
 * together, and so it participates correctly in a larger transaction (e.g.
 * a sale that also creates a Sale doc and Payment docs).
 */
async function applyStockChange({
  businessId, branchId, productId, variantId = null,
  quantityDelta, type, referenceType, referenceId, reason, performedBy,
  session, allowNegative = false, occurredAt = undefined, location = 'RETAIL', warehouseId = null,
  fromReserved = false, // consuming units that were reserved (layaway): takes them out of quantity AND reservedQuantity (retail stock only)
}) {
  if (!session) throw new Error('applyStockChange requires an active mongoose session');
  if (!quantityDelta) throw new Error('applyStockChange requires a non-zero quantityDelta');

  if (!LOCATIONS.includes(location)) throw new Error(`Unknown stock location: ${location}`);
  const Inventory = inventoryModel(location);
  let filter = { businessId, branchId, productId, variantId };
  // Warehouse stock is kept per WAREHOUSE (a branch may have several): rows are found by warehouseId.
  let insertOnly = null;
  if (location === 'WAREHOUSE') {
    if (!warehouseId) warehouseId = (await resolveWarehouse(businessId, { branchId, session }))._id;
    filter = { businessId, warehouseId, productId, variantId };
    insertOnly = { branchId };
  }
  let updated;

  if (fromReserved) {
    if (quantityDelta >= 0 || location !== 'RETAIL') throw new Error('fromReserved only applies to a retail decrement');
    updated = await Inventory.findOneAndUpdate(
      { ...filter, quantity: { $gte: -quantityDelta }, reservedQuantity: { $gte: -quantityDelta } },
      { $inc: { quantity: quantityDelta, reservedQuantity: quantityDelta } },
      { new: true, session }
    );
    if (!updated) throw ApiError.conflict('The reserved stock for this item is no longer there. Please contact support.', 'RESERVATION_MISSING');
  } else if (quantityDelta > 0 || allowNegative) {
    updated = await Inventory.findOneAndUpdate(
      filter,
      { $inc: { quantity: quantityDelta }, ...(insertOnly ? { $setOnInsert: insertOnly } : {}) },
      { upsert: true, new: true, session, setDefaultsOnInsert: true }
    );
  } else {
    // Atomic conditional decrement - see concurrency note above. Units reserved for a layaway are not for sale:
    // only (quantity - reservedQuantity) can be taken.
    updated = await Inventory.findOneAndUpdate(
      { ...filter, $expr: { $gte: [{ $subtract: ['$quantity', { $ifNull: ['$reservedQuantity', 0] }] }, -quantityDelta] } },
      { $inc: { quantity: quantityDelta } },
      { new: true, session }
    );

    if (!updated) {
      const existing = await Inventory.findOne(filter).session(session);
      const available = existing ? existing.quantity - existing.reservedQuantity : 0;
      throw ApiError.badRequest(
        `Insufficient ${location === 'WAREHOUSE' ? 'warehouse' : 'retail'} stock (available: ${available}, requested: ${-quantityDelta})`,
        'INSUFFICIENT_STOCK'
      );
    }
  }

  const previousStock = updated.quantity - quantityDelta;

    const [movement] = await InventoryMovement.create(
    [{ businessId, branchId, productId, variantId, location, warehouseId: location === 'WAREHOUSE' ? warehouseId : undefined, type, quantity: quantityDelta, previousStock, newStock: updated.quantity, referenceType, referenceId, reason, createdAt: occurredAt, performedBy, }],
    { session }
  );

  // Low/out-of-stock alert - fires only the moment stock CROSSES the
  // threshold going down, not on every sale while it stays low. Fired
  // from inside the caller's transaction rather than after commit (unlike
  // the sale/transfer hooks above), since applyStockChange is the one
  // choke point every stock mutation goes through - the trade-off is that
  // a notification could theoretically fire for a change that's later
  // rolled back, which is an acceptable risk for a non-critical alert.
  if (quantityDelta < 0 && location === 'RETAIL') { // low-stock alerts are about the shop floor
    const threshold = updated.lowStockThreshold ?? 5;
    const wasPositive = previousStock > 0;
    const wasAboveThreshold = previousStock > threshold;
    const nowOut = updated.quantity <= 0;
    const nowAtOrBelowThreshold = updated.quantity <= threshold;

    if ((nowOut && wasPositive) || (!nowOut && nowAtOrBelowThreshold && wasAboveThreshold)) {
      Product.findById(productId).select('name').then((product) => {
        if (!product) return;
        return notificationService.notifyStockLevel(businessId, branchId, {
          productId, variantId, productName: product.name, quantity: updated.quantity, threshold,
        });
      }).catch((err) => console.error('notifyStockLevel failed', err));
    }
  }

  return { branchInventory: updated, movement };
}

/**
 * Set units aside for a layaway (retail stock). They stay in `quantity` (they are physically still in the shop, so a stocktake
 * count matches) but leave the available quantity, so nothing else can sell, transfer or adjust them away.
 * Atomic: two layaways cannot both reserve the last unit.
 */
async function reserveStock({ businessId, branchId, productId, variantId = null, quantity, session }) {
  if (!session) throw new Error('reserveStock requires an active mongoose session');
  const updated = await BranchInventory.findOneAndUpdate(
    { businessId, branchId, productId, variantId, $expr: { $gte: [{ $subtract: ['$quantity', { $ifNull: ['$reservedQuantity', 0] }] }, quantity] } },
    { $inc: { reservedQuantity: quantity } },
    { new: true, session }
  );
  if (!updated) {
    const existing = await BranchInventory.findOne({ businessId, branchId, productId, variantId }).session(session);
    const available = existing ? existing.quantity - (existing.reservedQuantity || 0) : 0;
    throw ApiError.badRequest(`Insufficient stock to reserve (available: ${available}, requested: ${quantity})`, 'INSUFFICIENT_STOCK');
  }
  return updated;
}

/** Give reserved units back to sale (layaway cancelled). */
async function releaseReserved({ businessId, branchId, productId, variantId = null, quantity, session }) {
  if (!session) throw new Error('releaseReserved requires an active mongoose session');
  const updated = await BranchInventory.findOneAndUpdate(
    { businessId, branchId, productId, variantId, reservedQuantity: { $gte: quantity } },
    { $inc: { reservedQuantity: -quantity } },
    { new: true, session }
  );
  if (!updated) throw ApiError.conflict('The reserved stock for this item is no longer there. Please contact support.', 'RESERVATION_MISSING');
  return updated;
}

/**
 * Fetches (without creating) the current stock - pre-flight checks before a transaction starts.
 * For location 'WAREHOUSE' pass warehouseId to read ONE warehouse; without it the branch's warehouses are summed.
 * Quantities are in BASE units.
 */
async function getStockLevel(businessId, branchId, productId, variantId = null, location = 'RETAIL', warehouseId = null) {
  if (location === 'WAREHOUSE') {
    const filter = warehouseId ? { businessId, warehouseId, productId, variantId } : { businessId, branchId, productId, variantId };
    const rows = await WarehouseInventory.find(filter);
    const quantity = rows.reduce((s, r) => s + r.quantity, 0);
    const reservedQuantity = rows.reduce((s, r) => s + r.reservedQuantity, 0);
    return { quantity, reservedQuantity, availableQuantity: quantity - reservedQuantity };
  }
  const row = await BranchInventory.findOne({ businessId, branchId, productId, variantId });
  return { quantity: row?.quantity || 0, reservedQuantity: row?.reservedQuantity || 0, availableQuantity: (row?.quantity || 0) - (row?.reservedQuantity || 0) };
}

async function listBranchInventory(businessId, branchId, { page, limit, search, lowStockOnly, outOfStockOnly }) {
  const filter = { businessId, branchId };
  if (outOfStockOnly) filter.quantity = { $lte: 0 };

  let rows = await BranchInventory.find(filter).populate('productId', 'name sku barcode image unit units').sort({ updatedAt: -1 });

  if (search) {
    const re = new RegExp(search, 'i');
    rows = rows.filter((r) => re.test(r.productId?.name || '') || re.test(r.productId?.sku || ''));
  }

  // Low stock is evaluated per-row against either the row's own threshold or
  // the product's default, so it's applied after the DB query.
  if (lowStockOnly) {
    rows = rows.filter((r) => r.quantity - r.reservedQuantity <= (r.lowStockThreshold ?? 5));
  }

  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, (page - 1) * limit + limit);
  const items = paged.map((r) => { const o = r.toObject(); o.inUnits = unitBreakdown(r.productId, r.quantity); return o; }); // same stock also shown per bundle/carton
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getLowStockAlerts(businessId, branchId) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;

  const rows = await BranchInventory.find(filter).populate('productId', 'name sku').populate('branchId', 'name');
  const low = rows.filter((r) => r.quantity - r.reservedQuantity <= (r.lowStockThreshold ?? 5) && r.quantity > 0);
  const out = rows.filter((r) => r.quantity <= 0);
  return { lowStock: low, outOfStock: out, lowStockCount: low.length, outOfStockCount: out.length };
}

async function getMovements(businessId, { branchId, productId, variantId, type, location, page, limit }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (productId) filter.productId = productId;
  if (variantId) filter.variantId = variantId;
  if (type) filter.type = type;
  // Old rows have no location = RETAIL.
  if (location === 'RETAIL') filter.location = { $ne: 'WAREHOUSE' };
  else if (location === 'WAREHOUSE') filter.location = 'WAREHOUSE';

  const [items, total] = await Promise.all([
    InventoryMovement.find(filter)
      .populate('productId', 'name sku')
      .populate('performedBy', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    InventoryMovement.countDocuments(filter),
  ]);

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/** Manual stock adjustment (storekeeper correcting a count, marking damage/loss, etc). Runs its own transaction. */
async function adjustStock(businessId, branchId, userId, { productId, variantId, quantity: rawQuantity, unitId, reason, type, location = 'RETAIL' }) {
  const adjProduct = await assertItemExists(businessId, productId, variantId);
  const { quantity } = await toBaseQuantity(businessId, adjProduct, rawQuantity, unitId);
  if (location === 'WAREHOUSE') await assertWarehouseEnabled(businessId);
  const business = await Business.findById(businessId);
  const allowNegative = !!business?.settings?.allowNegativeStock;

  // ADJUSTMENT_IN/OUT, DAMAGE, EXPIRED, LOST are all manual adjustment types;
  // the sign of quantityDelta is derived from the type + the (always
  // positive) quantity the caller provides.
  const outboundTypes = ['ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRED', 'LOST'];
  const quantityDelta = outboundTypes.includes(type) ? -Math.abs(quantity) : Math.abs(quantity);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await applyStockChange({
        businessId, branchId, productId, variantId: variantId || null,
        quantityDelta, type, referenceType: 'ManualAdjustment', referenceId: null,
        reason, performedBy: userId, session, allowNegative, location,
      });

      await AuditLog.create(
        [{ businessId, branchId, userId, action: 'inventory.adjust', entityType: location === 'WAREHOUSE' ? 'WarehouseInventory' : 'BranchInventory', entityId: result.branchInventory._id, newValue: { type, quantityDelta, reason, location } }],
        { session }
      );
    });
    return result;
  } finally {
    session.endSession();
  }
}

/**
 * Receiving stock outside of a formal Purchase (e.g. opening stock, or a
 * quick "receive goods" action). Purchase-driven receiving lives in
 * purchase.service and calls applyStockChange directly within its own
 * transaction so it can also update the supplier balance atomically.
 */
async function receiveStock(businessId, branchId, userId, { productId, variantId, quantity, unitId, costPrice, batchNumber, expiryDate, manufacturingDate, reason, serials, condition, location = 'RETAIL' }) {
  const product = await assertItemExists(businessId, productId, variantId);
  { // unit conversion: 10 bundles @ 1,200 -> 240 packets @ 50
    const c = await toBaseQuantity(businessId, product, quantity, unitId);
    quantity = c.quantity;
    if (costPrice != null && c.factor !== 1) costPrice = Math.round(costPrice / c.factor);
  }
  if (location === 'WAREHOUSE') await assertWarehouseEnabled(businessId);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await applyStockChange({
        businessId, branchId, productId, variantId: variantId || null,
        quantityDelta: Math.abs(quantity), type: 'OPENING_STOCK',
        referenceType: 'ManualReceive', referenceId: null, reason, performedBy: userId, session, location,
      });

      if (product.trackSerialNumber) {
        const serialService = require('./serial.service'); // lazy: serial.service requires this module
        if (!serials?.length) throw ApiError.badRequest(`${product.name} is serial-tracked: give the serial number(s) / IMEI(s) of the units received`, 'SERIAL_DETAILS_REQUIRED');
        await serialService.registerSerials({
          businessId, branchId, userId, product, variantId: variantId || null, quantity: Math.abs(quantity),
          serials, costPrice: costPrice ?? product.costPrice, condition: condition || 'new', session, location,
        });
      }

      if (product.trackBatch) {
        const biz = await Business.findById(businessId).select('featureSettings').session(session);
        if (batchNumber) {
          const batchService = require('./batch.service'); // lazy: batch.service requires this module
          await batchService.receiveIntoBatch({
            businessId, branchId, product, variantId: variantId || null, quantity: Math.abs(quantity),
            batchNumber, expiryDate, manufacturingDate, costPrice, session, location,
          });
        } else if (biz?.featureSettings?.batchTracking) {
          throw ApiError.badRequest(`${product.name} is batch-tracked: a batch number${product.trackExpiry ? ' and expiry date are' : ' is'} required`, 'BATCH_DETAILS_REQUIRED');
        }
      }

      await AuditLog.create(
        [{ businessId, branchId, userId, action: 'inventory.receive', entityType: location === 'WAREHOUSE' ? 'WarehouseInventory' : 'BranchInventory', entityId: result.branchInventory._id, newValue: { quantity, location } }],
        { session }
      );
    });
    return result;
  } finally {
    session.endSession();
  }
}

/** Warehouse stock is a business option (feature flag `multiWarehouse`, on by default for wholesale shops). */
async function assertWarehouseEnabled(businessId, session = null) {
  const q = Business.findById(businessId).select('featureSettings');
  const biz = await (session ? q.session(session) : q);
  if (!biz?.featureSettings?.multiWarehouse) {
    throw ApiError.forbidden('Warehouse stock is not enabled for your business (multiWarehouse)', 'FEATURE_DISABLED');
  }
}

async function assertItemExists(businessId, productId, variantId) {
  const product = await Product.findOne({ _id: productId, businessId });
  if (!product) throw ApiError.notFound('Product not found');
  if (variantId) {
    const variant = await ProductVariant.findOne({ _id: variantId, businessId, productId });
    if (!variant) throw ApiError.notFound('Variant not found');
  }
  return product;
}

module.exports = {
  LOCATIONS,
  inventoryModel,
  assertWarehouseEnabled,
  applyStockChange,
  reserveStock,
  releaseReserved,
  getStockLevel,
  listBranchInventory,
  getLowStockAlerts,
  getMovements,
  adjustStock,
  receiveStock,
};