const Batch = require('../models/Batch');
const Sale = require('../models/Sale');
const AuditLog = require('../models/AuditLog');
const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const { applyStockChange } = require('./inventory.service');

/**
 * Batch / expiry engine. Shared by supermarket, cosmetics, restaurant (ingredients), pharmacy, wholesale.
 *
 * INVARIANT: BranchInventory.quantity counts SELLABLE stock only.
 *   - an `active` batch's quantity is inside BranchInventory.quantity
 *   - a `quarantined` / `recalled` batch's quantity is NOT (it is moved out when quarantined, back in when released)
 * Every function that mutates stock takes the caller's mongoose session so it commits or rolls back with it.
 */

const round3 = (n) => Math.round(n * 1000) / 1000;

/** Batches stay sellable through their expiry date; they expire at the start of the next day (UTC). */
function startOfToday(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
const sameDay = (a, b) => startOfToday(new Date(a)).getTime() === startOfToday(new Date(b)).getTime();
const isExpired = (batch, now = new Date()) => !!batch.expiryDate && new Date(batch.expiryDate) < startOfToday(now);

function eligibleFilter({ businessId, branchId, productId, variantId = null }, now = new Date()) {
  return {
    businessId, branchId, productId, variantId: variantId || null,
    status: 'active',
    quantity: { $gt: 0 },
    $or: [{ expiryDate: null }, { expiryDate: { $exists: false } }, { expiryDate: { $gte: startOfToday(now) } }],
  };
}

const fefoSort = (a, b) => {
  const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
  const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
  return ea - eb || new Date(a.createdAt) - new Date(b.createdAt);
};

function ineligibleReason(batch, scope) {
  if (!batch) return 'Batch not found';
  if (String(batch.businessId) !== String(scope.businessId)) return 'Batch not found';
  if (String(batch.branchId) !== String(scope.branchId)) return 'Batch belongs to another branch';
  if (String(batch.productId) !== String(scope.productId)) return 'Batch belongs to another product';
  if (String(batch.variantId || '') !== String(scope.variantId || '')) return 'Batch belongs to another variant';
  if (batch.status !== 'active') return `Batch is ${batch.status}`;
  if (isExpired(batch)) return 'Batch has expired';
  if (batch.quantity <= 0) return 'Batch is empty';
  return null;
}

/**
 * Take `quantity` units for a sale, inside the caller's transaction.
 *  - requestedBatchId: cashier picked a batch -> it must be eligible (same business/branch/product/variant,
 *    active, not expired). Never silently substituted.
 *  - otherwise FEFO: earliest-expiring eligible batches first, possibly spanning several batches.
 *  - allowUnbatchedRemainder: legacy stock that was never put into batches may still be sold (non-regulated
 *    businesses only). Pharmacy/cosmetics pass false, so the sale fails instead.
 * Decrements are atomic per batch ($gte guard), so concurrent sales cannot take the same units twice.
 * Returns [{ batchId, batchNumber, expiryDate, quantity }].
 */
async function allocateForSale({
  businessId, branchId, productId, variantId = null, quantity, requestedBatchId = null,
  allowUnbatchedRemainder = false, productName = 'product', session,
}) {
  if (!session) throw new Error('allocateForSale requires a session');
  const scope = { businessId, branchId, productId, variantId };
  let remaining = round3(quantity);
  const allocations = [];

  const take = async (batch, qty) => {
    const updated = await Batch.findOneAndUpdate(
      { _id: batch._id, businessId, status: 'active', quantity: { $gte: qty } },
      { $inc: { quantity: -qty } },
      { new: true, session }
    );
    if (!updated) return false;
    if (updated.quantity <= 0) { updated.status = 'depleted'; await updated.save({ session }); }
    allocations.push({
      batchId: updated._id, batchNumber: updated.batchNumber, expiryDate: updated.expiryDate,
      manufacturingDate: updated.manufacturingDate, unitCostCents: updated.costPrice || 0, quantity: qty,
    });
    return true;
  };

  if (requestedBatchId) {
    const batch = await Batch.findOne({ _id: requestedBatchId, businessId }).session(session);
    const reason = ineligibleReason(batch, scope);
    if (reason) throw ApiError.badRequest(`${productName}: ${reason}`, 'BATCH_INELIGIBLE');
    if (batch.quantity < remaining) {
      throw ApiError.badRequest(`${productName}: batch ${batch.batchNumber} has only ${batch.quantity} left`, 'INSUFFICIENT_BATCH_STOCK');
    }
    if (!(await take(batch, remaining))) throw ApiError.badRequest(`Insufficient batch stock for ${productName}`, 'INSUFFICIENT_BATCH_STOCK');
    return allocations;
  }

  // FEFO. Re-read after a lost race, at most a few times.
  for (let attempt = 0; attempt < 5 && remaining > 0; attempt += 1) {
    const batches = (await Batch.find(eligibleFilter(scope)).session(session)).sort(fefoSort);
    if (!batches.length) break;
    let progressed = false;
    for (const b of batches) {
      if (remaining <= 0) break;
      const qty = round3(Math.min(remaining, b.quantity));
      if (qty <= 0) continue;
      if (await take(b, qty)) { remaining = round3(remaining - qty); progressed = true; }
    }
    if (!progressed) break;
  }

  if (remaining > 0) {
    if (allowUnbatchedRemainder) return allocations; // the rest is legacy un-batched stock
    const anyBatch = await Batch.exists({ businessId, branchId, productId, variantId: variantId || null }).session(session);
    throw ApiError.badRequest(
      anyBatch
        ? `${productName}: not enough in-date, sellable batch stock (short by ${remaining}). Expired, quarantined or recalled batches cannot be sold.`
        : `${productName}: no batch stock recorded. Receive stock with a batch number and expiry first.`,
      anyBatch ? 'NO_ELIGIBLE_BATCH' : 'NO_BATCH_STOCK'
    );
  }
  return allocations;
}

/**
 * Put sold units back into their batches (sale cancelled / refund restocked).
 * Returns the quantity that went into batches which are NOT sellable (quarantined/recalled/expired), so the
 * caller can keep BranchInventory consistent.
 */
async function restoreAllocations(businessId, saleItem, session, quantity = null) {
  const allocs = saleItem.batchAllocations?.length
    ? saleItem.batchAllocations
    : (saleItem.batchId ? [{ batchId: saleItem.batchId, quantity: saleItem.quantity }] : []);
  let toRestore = quantity == null ? Infinity : quantity;
  let notSellable = 0;
  for (const a of allocs) {
    if (toRestore <= 0) break;
    const qty = Math.min(a.quantity, toRestore);
    const batch = await Batch.findOneAndUpdate({ _id: a.batchId, businessId }, { $inc: { quantity: qty } }, { new: true, session });
    if (batch) {
      if (batch.status === 'depleted') { batch.status = 'active'; await batch.save({ session }); }
      else if (batch.status !== 'active' || isExpired(batch)) notSellable += qty;
    }
    toRestore -= qty;
  }
  return notSellable;
}

/**
 * Goods arriving into a batch (purchase receipt or opening stock). Validates the supplier's real batch data.
 * The caller updates BranchInventory (applyStockChange); this only maintains the batch.
 */
async function receiveIntoBatch({
  businessId, branchId, product, variantId = null, quantity, batchNumber, expiryDate, manufacturingDate,
  costPrice, supplierId, purchaseId, session, legacy = false, allowExpired = false,
}) {
  if (!batchNumber || !String(batchNumber).trim()) throw ApiError.badRequest(`${product.name}: batch number is required`, 'BATCH_NUMBER_REQUIRED');
  batchNumber = String(batchNumber).trim();
  const expiry = expiryDate ? new Date(expiryDate) : null;
  const mfg = manufacturingDate ? new Date(manufacturingDate) : null;

  if (product.trackExpiry && !expiry && !legacy) throw ApiError.badRequest(`${product.name}: expiry date is required`, 'EXPIRY_REQUIRED');
  if (expiry && Number.isNaN(expiry.getTime())) throw ApiError.badRequest(`${product.name}: invalid expiry date`, 'INVALID_EXPIRY');
  if (expiry && expiry < startOfToday() && !allowExpired) throw ApiError.badRequest(`${product.name}: batch ${batchNumber} is already expired and cannot be received into stock`, 'EXPIRED_ON_RECEIPT');
  if (mfg && expiry && mfg > expiry) throw ApiError.badRequest(`${product.name}: manufacturing date is after expiry`, 'INVALID_BATCH_DATES');

  const batch = await Batch.findOneAndUpdate(
    { businessId, branchId, productId: product._id, batchNumber },
    {
      $inc: { quantity },
      $setOnInsert: {
        variantId: variantId || null, costPrice: costPrice ?? product.costPrice ?? 0,
        manufacturingDate: mfg || undefined, expiryDate: expiry || undefined,
        supplierId: supplierId || undefined, purchaseId: purchaseId || undefined, receivedAt: new Date(),
      },
    },
    { upsert: true, new: true, session, setDefaultsOnInsert: true }
  );

  // Same batch number must mean the same expiry, and a held batch cannot take more stock silently.
  if (expiry && batch.expiryDate && !sameDay(batch.expiryDate, expiry)) {
    throw ApiError.conflict(`${product.name}: batch ${batchNumber} already exists with a different expiry date`, 'BATCH_EXPIRY_MISMATCH');
  }
  if (String(batch.variantId || '') !== String(variantId || '')) {
    throw ApiError.conflict(`${product.name}: batch ${batchNumber} belongs to another variant`, 'BATCH_VARIANT_MISMATCH');
  }
  if (batch.status !== 'active') {
    if (batch.status === 'depleted') { batch.status = 'active'; await batch.save({ session }); }
    else throw ApiError.conflict(`${product.name}: batch ${batchNumber} is ${batch.status} and cannot be received into`, 'BATCH_NOT_RECEIVABLE');
  }
  return batch;
}

// ---------------------------------------------------------------- status changes

async function inTx(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally { session.endSession(); }
}

async function loadBatch(businessId, id, session) {
  const batch = await Batch.findOne({ _id: id, businessId }).session(session);
  if (!batch) throw ApiError.notFound('Batch not found');
  return batch;
}

/** Hold a batch back from sale. Its remaining quantity leaves sellable stock. */
async function quarantineBatch(businessId, userId, id, { reason, recall = false }) {
  if (!reason || !String(reason).trim()) throw ApiError.badRequest('A reason is required', 'REASON_REQUIRED');
  return inTx(async (session) => quarantineWithin(businessId, userId, id, { reason, recall }, session));
}

async function quarantineWithin(businessId, userId, id, { reason, recall }, session) {
  const batch = await loadBatch(businessId, id, session);
  if (batch.status === 'quarantined' || batch.status === 'recalled') return batch;
  if (batch.status !== 'active') throw ApiError.conflict(`Batch is ${batch.status}`, 'INVALID_BATCH_STATE');

  if (batch.quantity > 0) {
    await applyStockChange({
      businessId, branchId: batch.branchId, productId: batch.productId, variantId: batch.variantId || null,
      quantityDelta: -batch.quantity, type: 'ADJUSTMENT_OUT', referenceType: 'Batch', referenceId: batch._id,
      reason: `${recall ? 'Recall' : 'Quarantine'} batch ${batch.batchNumber}: ${reason}`, performedBy: userId, session, allowNegative: true,
    });
  }
  batch.status = recall ? 'recalled' : 'quarantined';
  batch.statusReason = reason; batch.statusChangedAt = new Date(); batch.statusChangedBy = userId;
  await batch.save({ session });
  await AuditLog.create([{ businessId, branchId: batch.branchId, userId, action: recall ? 'batch.recall' : 'batch.quarantine', entityType: 'Batch', entityId: batch._id, newValue: { reason, quantity: batch.quantity } }], { session });
  return batch;
}

/** Authorised release of a quarantined batch back to sellable stock. Expired or recalled batches cannot be released. */
async function releaseBatch(businessId, userId, id, { reason }) {
  if (!reason || !String(reason).trim()) throw ApiError.badRequest('A reason is required', 'REASON_REQUIRED');
  return inTx(async (session) => {
    const batch = await loadBatch(businessId, id, session);
    if (batch.status === 'recalled') throw ApiError.conflict('A recalled batch cannot be released; dispose of it or return it to the supplier', 'BATCH_RECALLED');
    if (batch.status !== 'quarantined') throw ApiError.conflict(`Batch is ${batch.status}, not quarantined`, 'INVALID_BATCH_STATE');
    if (isExpired(batch)) throw ApiError.conflict('Batch has expired and cannot be released', 'BATCH_EXPIRED');

    if (batch.quantity > 0) {
      await applyStockChange({
        businessId, branchId: batch.branchId, productId: batch.productId, variantId: batch.variantId || null,
        quantityDelta: batch.quantity, type: 'ADJUSTMENT_IN', referenceType: 'Batch', referenceId: batch._id,
        reason: `Release batch ${batch.batchNumber}: ${reason}`, performedBy: userId, session,
      });
    }
    batch.status = 'active'; batch.statusReason = reason; batch.statusChangedAt = new Date(); batch.statusChangedBy = userId;
    await batch.save({ session });
    await AuditLog.create([{ businessId, branchId: batch.branchId, userId, action: 'batch.release', entityType: 'Batch', entityId: batch._id, newValue: { reason, quantity: batch.quantity } }], { session });
    return batch;
  });
}

/** Write off the remaining quantity (expired, damaged, destroyed). Works on active or held batches. */
async function disposeBatch(businessId, userId, id, { reason, type = 'EXPIRED' }) {
  if (!reason || !String(reason).trim()) throw ApiError.badRequest('A reason is required', 'REASON_REQUIRED');
  if (!['EXPIRED', 'DAMAGE', 'LOST'].includes(type)) throw ApiError.badRequest('Invalid disposal type', 'INVALID_TYPE');
  return inTx(async (session) => {
    const batch = await loadBatch(businessId, id, session);
    if (batch.status === 'depleted' || batch.status === 'expired') throw ApiError.conflict(`Batch is already ${batch.status}`, 'INVALID_BATCH_STATE');
    const qty = batch.quantity;
    // Only ACTIVE batches are inside BranchInventory; held batches were already moved out.
    if (qty > 0 && batch.status === 'active') {
      await applyStockChange({
        businessId, branchId: batch.branchId, productId: batch.productId, variantId: batch.variantId || null,
        quantityDelta: -qty, type, referenceType: 'Batch', referenceId: batch._id,
        reason: `Dispose batch ${batch.batchNumber}: ${reason}`, performedBy: userId, session, allowNegative: true,
      });
    }
    batch.quantity = 0; batch.status = type === 'EXPIRED' ? 'expired' : 'depleted';
    batch.statusReason = reason; batch.statusChangedAt = new Date(); batch.statusChangedBy = userId;
    await batch.save({ session });
    await AuditLog.create([{ businessId, branchId: batch.branchId, userId, action: 'batch.dispose', entityType: 'Batch', entityId: batch._id, newValue: { reason, type, quantity: qty } }], { session });
    return batch;
  });
}

/**
 * Recall by batch number: holds every batch with that number (optionally one product / branch) and lists the
 * sales that included them. Returns receipt references only. No customer health or purchase detail.
 */
async function recallByBatchNumber(businessId, userId, { batchNumber, productId, branchId, reason }) {
  if (!batchNumber) throw ApiError.badRequest('Batch number is required', 'BATCH_NUMBER_REQUIRED');
  const filter = { businessId, batchNumber: String(batchNumber).trim() };
  if (productId) filter.productId = productId;
  if (branchId) filter.branchId = branchId;

  const batches = await inTx(async (session) => {
    const found = await Batch.find(filter).session(session);
    if (!found.length) throw ApiError.notFound('No batch matches that batch number');
    const out = [];
    for (const b of found) out.push(await quarantineWithin(businessId, userId, b._id, { reason: reason || 'Recall', recall: true }, session));
    return out;
  });
  const affectedSales = await tracedSales(businessId, batches.map((b) => b._id));
  return { batches, affectedSales };
}

async function tracedSales(businessId, batchIds) {
  return Sale.find({ businessId, $or: [{ 'items.batchAllocations.batchId': { $in: batchIds } }, { 'items.batchId': { $in: batchIds } }] })
    .select('receiptNumber branchId createdAt saleStatus total')
    .sort({ createdAt: -1 }).limit(1000).lean();
}

/**
 * Customer-returned units of a batch-tracked product go into a QUARANTINED return batch (not sellable stock)
 * until someone inspects them (release or dispose). Units are traced to the batch(es) they were sold from.
 */
async function quarantineReturn({ businessId, branchId, userId, saleItem, quantity, refundNumber, receiptNumber, session }) {
  const allocs = saleItem.batchAllocations?.length
    ? saleItem.batchAllocations
    : (saleItem.batchId ? [{ batchId: saleItem.batchId, quantity: saleItem.quantity }] : []);
  let left = quantity;
  const targets = [];
  for (const a of allocs) {
    if (left <= 0) break;
    const qty = Math.min(a.quantity, left);
    const orig = await Batch.findOne({ _id: a.batchId, businessId }).session(session);
    if (orig) targets.push({ orig, qty });
    left -= qty;
  }
  if (!targets.length) {
    // Sold from legacy un-batched stock: still hold it, under a synthetic return batch.
    targets.push({ orig: null, qty: quantity });
  } else if (left > 0) {
    targets[targets.length - 1].qty += left;
  }
  for (const { orig, qty } of targets) {
    const batchNumber = orig ? `${orig.batchNumber}-RTN` : `RTN-${receiptNumber || refundNumber}`;
    const rb = await Batch.findOneAndUpdate(
      { businessId, branchId, productId: saleItem.productId, batchNumber },
      {
        $inc: { quantity: qty },
        $setOnInsert: {
          variantId: saleItem.variantId || null, costPrice: orig?.costPrice || 0,
          expiryDate: orig?.expiryDate, manufacturingDate: orig?.manufacturingDate,
          parentBatchId: orig?._id, receivedAt: new Date(),
        },
        $set: { status: 'quarantined', statusReason: `Customer return ${refundNumber}: awaiting inspection`, statusChangedAt: new Date(), statusChangedBy: userId },
      },
      { upsert: true, new: true, session, setDefaultsOnInsert: true }
    );
    await AuditLog.create([{ businessId, branchId, userId, action: 'batch.return_quarantined', entityType: 'Batch', entityId: rb._id, newValue: { refundNumber, quantity: qty } }], { session });
  }
}

// ---------------------------------------------------------------- queries

async function listBatches(businessId, { branchId, productId, status, search, page = 1, limit = 50 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (productId) filter.productId = productId;
  if (status) filter.status = status;
  if (search) filter.batchNumber = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [items, total] = await Promise.all([
    Batch.find(filter).populate('productId', 'name sku').sort({ expiryDate: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Batch.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/** Batches with stock that expire within `days` (default 30), plus already-expired batches still holding stock. */
async function listExpiring(businessId, { branchId, days = 30 }) {
  const now = new Date();
  const limitDate = new Date(startOfToday(now).getTime() + days * 86400000);
  const base = { businessId, quantity: { $gt: 0 }, status: 'active', expiryDate: { $ne: null } };
  if (branchId) base.branchId = branchId;
  const [expired, expiring] = await Promise.all([
    Batch.find({ ...base, expiryDate: { $lt: startOfToday(now) } }).populate('productId', 'name sku').sort({ expiryDate: 1 }).limit(500).lean(),
    Batch.find({ ...base, expiryDate: { $gte: startOfToday(now), $lte: limitDate } }).populate('productId', 'name sku').sort({ expiryDate: 1 }).limit(500).lean(),
  ]);
  const value = (arr) => arr.reduce((s, b) => s + b.quantity * (b.costPrice || 0), 0);
  return { days, expired, expiring, expiredCostValue: value(expired), expiringCostValue: value(expiring) };
}

module.exports = {
  startOfToday, isExpired, eligibleFilter,
  allocateForSale, restoreAllocations, receiveIntoBatch, quarantineReturn,
  quarantineBatch, releaseBatch, disposeBatch, recallByBatchNumber, tracedSales,
  listBatches, listExpiring,
};