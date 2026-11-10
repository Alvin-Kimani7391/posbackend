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
const Category = require('../models/Category');
const { resolveUnit, round3, unitBreakdown, weightedCost } = require('../utils/units');

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

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
  clampAtZero = false, // NEVER-NEGATIVE: take only what is really on hand (never below 0). The shortfall is reported in the result (shortBy) and written on the ledger row. For flows that must not be blocked (goods already left the shop) but must not produce negative stock.
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
  let shortBy = 0;

  // NEVER-NEGATIVE floor: work out how much can really be taken; the atomic conditional decrement below then applies it.
  if (clampAtZero && !allowNegative && !fromReserved && quantityDelta < 0) {
    const current = await Inventory.findOne(filter).session(session);
    const onHand = Math.max(0, num(current?.quantity) - num(current?.reservedQuantity));
    const take = Math.min(-quantityDelta, onHand);
    shortBy = round3(-quantityDelta - take);
    if (take <= 0) {
      // Nothing on hand: stock stays at its level, no movement can be written for a zero change.
      return { branchInventory: current || { _id: null, quantity: 0, reservedQuantity: 0 }, movement: null, shortBy, appliedDelta: 0 };
    }
    quantityDelta = -take;
    if (shortBy > 0) reason = `${reason ? `${reason} ` : ''}(stock record was short by ${shortBy}; only ${take} could be deducted)`;
  }

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
      const available = existing ? existing.quantity - num(existing.reservedQuantity) : 0;
      throw ApiError.badRequest(
        `Insufficient ${location === 'WAREHOUSE' ? 'warehouse' : 'retail'} stock (available: ${available}, requested: ${-quantityDelta})`,
        'INSUFFICIENT_STOCK'
      );
    }
  }

  const previousStock = updated.quantity - quantityDelta;

  const [movement] = await InventoryMovement.create(
    [{ businessId, branchId, productId, variantId, location, warehouseId: location === 'WAREHOUSE' ? warehouseId : undefined, type, quantity: quantityDelta, previousStock, newStock: updated.quantity, referenceType, referenceId, reason, createdAt: occurredAt, performedBy }],
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

  return { branchInventory: updated, movement, shortBy, appliedDelta: quantityDelta };
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
    const reservedQuantity = rows.reduce((s, r) => s + num(r.reservedQuantity), 0);
    return { quantity, reservedQuantity, availableQuantity: quantity - reservedQuantity };
  }
  const row = await BranchInventory.findOne({ businessId, branchId, productId, variantId });
  return { quantity: row?.quantity || 0, reservedQuantity: row?.reservedQuantity || 0, availableQuantity: (row?.quantity || 0) - (row?.reservedQuantity || 0) };
}

async function listBranchInventory(businessId, branchId, { page = 1, limit = 20, search, categoryId, lowStockOnly, outOfStockOnly } = {}) {
  page = Math.max(1, Number(page) || 1); limit = Math.min(200, Math.max(1, Number(limit) || 20));
  const match = { businessId: oid(businessId), branchId: oid(branchId) };

  // Everything (search, category, low / out of stock) is done in the database and the order is STABLE (product name, then id).
  // The old list was sorted by "last changed", so every sale re-shuffled the rows between pages and products seemed to
  // vanish from one page and appear twice on another. Now a row only moves when its product is renamed.
  const after = [];
  if (categoryId) after.push({ 'product.categoryId': oid(categoryId) });
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    after.push({ $or: [{ 'product.name': rx }, { 'product.sku': rx }, { 'product.barcode': rx }] });
  }
  if (outOfStockOnly) after.push({ quantity: { $lte: 0 } });
  if (lowStockOnly) after.push({ $expr: { $lte: ['$available', '$threshold'] } });

  const pipeline = [
    { $match: match },
    { $lookup: { from: Product.collection.name, localField: 'productId', foreignField: '_id', as: 'product' } },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    { $addFields: {
      reservedQuantity: { $ifNull: ['$reservedQuantity', 0] },
      available: { $subtract: [{ $ifNull: ['$quantity', 0] }, { $ifNull: ['$reservedQuantity', 0] }] },
      threshold: { $ifNull: ['$lowStockThreshold', 5] },
      nameKey: { $toLower: { $ifNull: ['$product.name', '~'] } },
    } },
    ...(after.length ? [{ $match: { $and: after } }] : []),
    { $facet: {
      items: [{ $sort: { nameKey: 1, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
      total: [{ $count: 'n' }],
    } },
  ];
  const [res] = await BranchInventory.aggregate(pipeline);
  const total = res?.total?.[0]?.n || 0;
  const items = (res?.items || []).map((r) => {
    const p = r.product;
    return {
      _id: r._id, businessId: r.businessId, branchId: r.branchId, variantId: r.variantId || null,
      quantity: num(r.quantity), reservedQuantity: num(r.reservedQuantity), availableQuantity: r.available, lowStockThreshold: r.threshold,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
      productId: p ? { _id: p._id, name: p.name, sku: p.sku, barcode: p.barcode, image: p.image, unit: p.unit, units: p.units, categoryId: p.categoryId } : r.productId,
      inUnits: unitBreakdown(p, num(r.quantity)), // same stock also shown per bundle/carton
    };
  });
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getLowStockAlerts(businessId, branchId) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;

  const rows = await BranchInventory.find(filter).populate('productId', 'name sku').populate('branchId', 'name');
  const avail = (r) => num(r.quantity) - num(r.reservedQuantity); // a row without reservedQuantity must not turn into NaN (it would silently drop out of the alerts)
  const low = rows.filter((r) => avail(r) <= (r.lowStockThreshold ?? 5) && r.quantity > 0);
  const out = rows.filter((r) => r.quantity <= 0);
  return { lowStock: low, outOfStock: out, lowStockCount: low.length, outOfStockCount: out.length };
}

/** A category and all the categories below it (so "Drinks" also shows its sub-categories). */
async function categoryTreeIds(businessId, categoryId) {
  const ids = new Set([String(categoryId)]);
  let frontier = [String(categoryId)];
  for (let depth = 0; depth < 6 && frontier.length; depth += 1) {
    const kids = await Category.find({ businessId, parentCategoryId: { $in: frontier.map(oid) } }).select('_id').lean();
    frontier = kids.map((k) => String(k._id)).filter((id) => !ids.has(id));
    frontier.forEach((id) => ids.add(id));
  }
  return [...ids].map(oid);
}

/**
 * Stock movement history with filters: branch, one product (or variant), a category (with its sub-categories), a text search on
 * product name / SKU / barcode, movement type, stock location and a date range (from / to). Newest first with a stable order.
 * Also returns totals for the WHOLE filtered result (not just the page): units in, units out, net and the number of movements.
 */
async function getMovements(businessId, { branchId, productId, variantId, categoryId, search, type, location, from, to, page = 1, limit = 20 } = {}) {
  page = Math.max(1, Number(page) || 1); limit = Math.min(200, Math.max(1, Number(limit) || 20));
  const filter = { businessId: oid(businessId) };
  if (branchId) filter.branchId = oid(branchId);
  if (variantId) filter.variantId = oid(variantId);
  if (type) filter.type = type;
  // Old rows have no location = RETAIL.
  if (location === 'RETAIL') filter.location = { $ne: 'WAREHOUSE' };
  else if (location === 'WAREHOUSE') filter.location = 'WAREHOUSE';

  const fromD = from ? new Date(from) : null;
  const toD = to ? new Date(to) : null;
  if ((fromD && !Number.isNaN(fromD.getTime())) || (toD && !Number.isNaN(toD.getTime()))) {
    filter.createdAt = {};
    if (fromD && !Number.isNaN(fromD.getTime())) filter.createdAt.$gte = fromD;
    if (toD && !Number.isNaN(toD.getTime())) filter.createdAt.$lte = toD;
  }

  // product / category / search all narrow down to a list of product ids
  let productIds = productId ? [oid(productId)] : null;
  if (categoryId || search) {
    const pf = { businessId: oid(businessId) };
    if (categoryId) pf.categoryId = { $in: await categoryTreeIds(businessId, categoryId) };
    if (search) { const rx = new RegExp(escapeRegex(search), 'i'); pf.$or = [{ name: rx }, { sku: rx }, { barcode: rx }]; }
    const found = (await Product.find(pf).select('_id').limit(5000).lean()).map((x) => x._id);
    if (productIds) { const keep = new Set(found.map(String)); productIds = productIds.filter((id) => keep.has(String(id))); } else productIds = found;
  }
  if (productIds) filter.productId = { $in: productIds };

  const [items, total, sums] = await Promise.all([
    InventoryMovement.find(filter)
      .populate('productId', 'name sku categoryId')
      .populate('performedBy', 'name')
      .populate('warehouseId', 'name')
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    InventoryMovement.countDocuments(filter),
    InventoryMovement.aggregate([
      { $match: filter },
      { $group: { _id: null, unitsIn: { $sum: { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0] } }, unitsOut: { $sum: { $cond: [{ $lt: ['$quantity', 0] }, '$quantity', 0] } } } },
    ]),
  ]);

  const unitsIn = round3(sums[0]?.unitsIn || 0);
  const unitsOut = round3(Math.abs(sums[0]?.unitsOut || 0));
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1, summary: { count: total, unitsIn, unitsOut, net: round3(unitsIn - unitsOut) } };
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
async function receiveStock(businessId, branchId, userId, { productId, variantId, quantity, unitId, costPrice, batchNumber, expiryDate, manufacturingDate, reason, serials, condition, location = 'RETAIL', updateCost = true }) {
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
        // Expiry-tracked stock must always land in a batch (that is where the expiry date lives). If the person gave
        // an expiry but no batch number, derive one from the expiry date: same expiry => same batch.
        if (!batchNumber && !biz?.featureSettings?.batchTracking && (product.trackExpiry || expiryDate)) {
          if (product.trackExpiry && !expiryDate) throw ApiError.badRequest(`${product.name} tracks expiry: an expiry date is required`, 'EXPIRY_REQUIRED');
          const d = new Date(expiryDate);
          if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`${product.name}: invalid expiry date`, 'INVALID_EXPIRY');
          batchNumber = `EXP-${d.toISOString().slice(0, 10).replace(/-/g, '')}`;
        }
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

      // Cost follows the stock: 1 bag (25 kg) received at 3,000 makes the kg cost 120. The product's cost per BASE unit
      // becomes the weighted average of what was on hand and what just arrived, so unit / fraction profit stays exact.
      if (updateCost && costPrice != null && costPrice > 0) {
        const holder = variantId ? await ProductVariant.findOne({ _id: variantId, businessId }).session(session) : product;
        if (holder) {
          const other = await getStockLevel(businessId, branchId, productId, variantId || null, location === 'WAREHOUSE' ? 'RETAIL' : 'WAREHOUSE').catch(() => ({ quantity: 0 }));
          const prevOnHand = (result.branchInventory.quantity - Math.abs(quantity)) + (other.quantity || 0);
          const next = weightedCost({ onHand: prevOnHand, oldCost: holder.costPrice || 0, addQty: Math.abs(quantity), addCost: costPrice });
          if (next !== holder.costPrice) {
            result.costUpdate = { from: holder.costPrice || 0, to: next };
            holder.costPrice = next;
            await holder.save({ session });
          }
        }
      }

      await AuditLog.create(
        [{ businessId, branchId, userId, action: 'inventory.receive', entityType: location === 'WAREHOUSE' ? 'WarehouseInventory' : 'BranchInventory', entityId: result.branchInventory._id, newValue: { quantity, location, ...(result.costUpdate ? { costPerBase: result.costUpdate } : {}) } }],
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