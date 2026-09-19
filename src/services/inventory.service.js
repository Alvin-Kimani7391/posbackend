const mongoose = require('mongoose');
const BranchInventory = require('../models/BranchInventory');
const InventoryMovement = require('../models/InventoryMovement');
const Batch = require('../models/Batch');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

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
 * MUST be called with an active mongoose session (the caller's transaction)
 * so the inventory update and its movement record commit or roll back
 * together, and so it participates correctly in a larger transaction (e.g.
 * a sale that also creates a Sale doc and Payment docs).
 */
async function applyStockChange({
  businessId, branchId, productId, variantId = null,
  quantityDelta, type, referenceType, referenceId, reason, performedBy,
  session, allowNegative = false,
}) {
  if (!session) throw new Error('applyStockChange requires an active mongoose session');
  if (!quantityDelta) throw new Error('applyStockChange requires a non-zero quantityDelta');

  const filter = { businessId, branchId, productId, variantId };
  let updated;

  if (quantityDelta > 0 || allowNegative) {
    updated = await BranchInventory.findOneAndUpdate(
      filter,
      { $inc: { quantity: quantityDelta } },
      { upsert: true, new: true, session, setDefaultsOnInsert: true }
    );
  } else {
    // Atomic conditional decrement - see concurrency note above.
    updated = await BranchInventory.findOneAndUpdate(
      { ...filter, quantity: { $gte: -quantityDelta } },
      { $inc: { quantity: quantityDelta } },
      { new: true, session }
    );

    if (!updated) {
      const existing = await BranchInventory.findOne(filter).session(session);
      const available = existing ? existing.quantity - existing.reservedQuantity : 0;
      throw ApiError.badRequest(
        `Insufficient stock (available: ${available}, requested: ${-quantityDelta})`,
        'INSUFFICIENT_STOCK'
      );
    }
  }

  const previousStock = updated.quantity - quantityDelta;

  const [movement] = await InventoryMovement.create(
    [{
      businessId, branchId, productId, variantId,
      type, quantity: quantityDelta, previousStock, newStock: updated.quantity,
      referenceType, referenceId, reason, performedBy,
    }],
    { session }
  );

  return { branchInventory: updated, movement };
}

/** Fetches (without creating) the current stock row - used for pre-flight checks before a transaction starts. */
async function getStockLevel(businessId, branchId, productId, variantId = null) {
  const row = await BranchInventory.findOne({ businessId, branchId, productId, variantId });
  return { quantity: row?.quantity || 0, reservedQuantity: row?.reservedQuantity || 0, availableQuantity: (row?.quantity || 0) - (row?.reservedQuantity || 0) };
}

async function listBranchInventory(businessId, branchId, { page, limit, search, lowStockOnly, outOfStockOnly }) {
  const filter = { businessId, branchId };
  if (outOfStockOnly) filter.quantity = { $lte: 0 };

  let rows = await BranchInventory.find(filter).populate('productId', 'name sku barcode image').sort({ updatedAt: -1 });

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
  return { items: paged, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getLowStockAlerts(businessId, branchId) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;

  const rows = await BranchInventory.find(filter).populate('productId', 'name sku').populate('branchId', 'name');
  const low = rows.filter((r) => r.quantity - r.reservedQuantity <= (r.lowStockThreshold ?? 5) && r.quantity > 0);
  const out = rows.filter((r) => r.quantity <= 0);
  return { lowStock: low, outOfStock: out, lowStockCount: low.length, outOfStockCount: out.length };
}

async function getMovements(businessId, { branchId, productId, variantId, type, page, limit }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (productId) filter.productId = productId;
  if (variantId) filter.variantId = variantId;
  if (type) filter.type = type;

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
async function adjustStock(businessId, branchId, userId, { productId, variantId, quantity, reason, type }) {
  await assertItemExists(businessId, productId, variantId);
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
        reason, performedBy: userId, session, allowNegative,
      });

      await AuditLog.create(
        [{ businessId, branchId, userId, action: 'inventory.adjust', entityType: 'BranchInventory', entityId: result.branchInventory._id, newValue: { type, quantityDelta, reason } }],
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
async function receiveStock(businessId, branchId, userId, { productId, variantId, quantity, costPrice, batchNumber, expiryDate, manufacturingDate, reason }) {
  const product = await assertItemExists(businessId, productId, variantId);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await applyStockChange({
        businessId, branchId, productId, variantId: variantId || null,
        quantityDelta: Math.abs(quantity), type: 'OPENING_STOCK',
        referenceType: 'ManualReceive', referenceId: null, reason, performedBy: userId, session,
      });

      if (product.trackBatch && batchNumber) {
        await Batch.findOneAndUpdate(
          { businessId, branchId, productId, batchNumber },
          {
            $inc: { quantity: Math.abs(quantity) },
            $setOnInsert: { variantId: variantId || null, costPrice: costPrice ?? product.costPrice, manufacturingDate, expiryDate },
          },
          { upsert: true, session }
        );
      }

      await AuditLog.create(
        [{ businessId, branchId, userId, action: 'inventory.receive', entityType: 'BranchInventory', entityId: result.branchInventory._id, newValue: { quantity } }],
        { session }
      );
    });
    return result;
  } finally {
    session.endSession();
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
  applyStockChange,
  getStockLevel,
  listBranchInventory,
  getLowStockAlerts,
  getMovements,
  adjustStock,
  receiveStock,
};
