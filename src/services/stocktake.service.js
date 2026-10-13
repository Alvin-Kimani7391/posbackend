const mongoose = require('mongoose');
const Stocktake = require('../models/Stocktake');
const BranchInventory = require('../models/BranchInventory');
const Product = require('../models/Product');
const Batch = require('../models/Batch');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange } = require('./inventory.service');
const batchService = require('./batch.service');

const round3 = (n) => Math.round(n * 1000) / 1000;

async function inTx(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally { session.endSession(); }
}

/** Counters in a blind count must not see what the system expects. */
function present(doc, { hideSystem }) {
  const obj = doc.toObject();
  if (hideSystem && doc.blind && doc.status === 'OPEN') {
    obj.lines = obj.lines.map(({ systemQtyAtStart, systemQtyAtCount, varianceQty, varianceValue, ...rest }) => rest);
  }
  return obj;
}

/** Start a count: snapshot the branch's stock lines (and active batches for batch-tracked products). */
async function createStocktake(businessId, branchId, userId, { name, scope = { type: 'ALL' }, blind = true }) {
  const open = await Stocktake.findOne({ businessId, branchId, status: { $in: ['OPEN', 'SUBMITTED'] } }).select('stocktakeNumber status');
  if (open) throw ApiError.conflict(`Finish or cancel ${open.stocktakeNumber} (${open.status}) before starting another count for this branch`, 'STOCKTAKE_IN_PROGRESS');

  const rowFilter = { businessId, branchId };
  if (scope.type === 'PRODUCTS') rowFilter.productId = { $in: scope.productIds || [] };
  let rows = await BranchInventory.find(rowFilter).lean();

  const products = await Product.find({
    businessId, _id: { $in: [...new Set(rows.map((r) => String(r.productId)))] }, status: 'active', trackInventory: true,
    ...(scope.type === 'CATEGORY' ? { categoryId: { $in: scope.categoryIds || [] } } : {}),
  }).select('name sku costPrice trackBatch').lean(); // lean => raw integer cents
  const byId = new Map(products.map((p) => [String(p._id), p]));
  rows = rows.filter((r) => byId.has(String(r.productId)));
  if (!rows.length) throw ApiError.badRequest('No stocked products match this count', 'EMPTY_STOCKTAKE');

  const lines = [];
  for (const r of rows) {
    const p = byId.get(String(r.productId));
    if (p.trackBatch) {
      const batches = await Batch.find({ businessId, branchId, productId: r.productId, variantId: r.variantId || null, status: 'active', quantity: { $gt: 0 } }).sort({ expiryDate: 1 }).lean();
      if (batches.length) {
        for (const b of batches) {
          lines.push({
            productId: r.productId, variantId: r.variantId || null, batchId: b._id, batchNumber: b.batchNumber, expiryDate: b.expiryDate,
            nameSnapshot: p.name, skuSnapshot: p.sku, unitCostCents: b.costPrice || p.costPrice || 0, systemQtyAtStart: b.quantity,
          });
        }
        continue;
      }
    }
    lines.push({
      productId: r.productId, variantId: r.variantId || null, nameSnapshot: p.name, skuSnapshot: p.sku,
      unitCostCents: p.costPrice || 0, systemQtyAtStart: r.quantity,
    });
  }

  const seq = await nextSequence(businessId, 'stocktake:business', undefined);
  const doc = await Stocktake.create({
    businessId, branchId, stocktakeNumber: `STK-${pad(seq)}`, name, blind, scope, lines, startedBy: userId,
  });
  await AuditLog.create({ businessId, branchId, userId, action: 'stocktake.start', entityType: 'Stocktake', entityId: doc._id, newValue: { lines: lines.length, blind } });
  return doc;
}

async function listStocktakes(businessId, { branchId, status, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Stocktake.find(filter).select('-lines').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Stocktake.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getStocktake(businessId, id, { hideSystem }) {
  const doc = await Stocktake.findOne({ _id: id, businessId });
  if (!doc) throw ApiError.notFound('Stocktake not found');
  const obj = present(doc, { hideSystem });
  const lines = doc.lines;
  obj.progress = { total: lines.length, counted: lines.filter((l) => l.countedQty != null).length };
  return obj;
}

/** Enter or correct counts. Re-entering a count is a recount (kept on the line). Only while OPEN. */
async function recordCounts(businessId, userId, id, counts) {
  return inTx(async (session) => {
    const doc = await Stocktake.findOne({ _id: id, businessId }).session(session);
    if (!doc) throw ApiError.notFound('Stocktake not found');
    if (doc.status !== 'OPEN') throw ApiError.conflict(`Counts can only be entered while the stocktake is OPEN (it is ${doc.status})`, 'INVALID_STOCKTAKE_STATE');

    for (const c of counts) {
      const line = doc.lines.id(c.lineId);
      if (!line) throw ApiError.badRequest(`Line ${c.lineId} is not part of this stocktake`, 'INVALID_LINE');
      let live;
      if (line.batchId) {
        const b = await Batch.findOne({ _id: line.batchId, businessId }).session(session);
        live = b && b.status === 'active' ? b.quantity : 0;
      } else {
        const row = await BranchInventory.findOne({ businessId, branchId: doc.branchId, productId: line.productId, variantId: line.variantId || null }).session(session);
        live = row?.quantity || 0;
      }
      if (line.countedQty != null) line.recountCount += 1;
      line.systemQtyAtCount = live;
      line.countedQty = c.countedQty;
      line.countedBy = userId;
      line.countedAt = new Date();
      if (c.note !== undefined) line.note = c.note;
      line.varianceQty = round3(c.countedQty - live);
      line.varianceValue = Math.round(line.varianceQty * (line.unitCostCents || 0));
      line.decision = 'PENDING';
    }
    await doc.save({ session });
    return { counted: doc.lines.filter((l) => l.countedQty != null).length, total: doc.lines.length };
  });
}

/** Finish counting. All lines must be counted unless the caller explicitly leaves the rest out. */
async function submitStocktake(businessId, userId, id, { skipUncounted = false } = {}) {
  const doc = await Stocktake.findOne({ _id: id, businessId });
  if (!doc) throw ApiError.notFound('Stocktake not found');
  if (doc.status !== 'OPEN') throw ApiError.conflict(`Stocktake is ${doc.status}`, 'INVALID_STOCKTAKE_STATE');
  const uncounted = doc.lines.filter((l) => l.countedQty == null);
  if (uncounted.length && !skipUncounted) {
    throw ApiError.badRequest(`${uncounted.length} line(s) have not been counted. Count them, or submit with skipUncounted to leave them unchanged.`, 'UNCOUNTED_LINES');
  }
  doc.status = 'SUBMITTED'; doc.submittedBy = userId; doc.submittedAt = new Date();
  await doc.save();
  await AuditLog.create({ businessId, branchId: doc.branchId, userId, action: 'stocktake.submit', entityType: 'Stocktake', entityId: doc._id, newValue: { uncounted: uncounted.length } });
  return doc;
}

/**
 * Manager review. Approves every counted line that has a variance, except `rejectLineIds` (those keep the system
 * quantity and are recorded as REJECTED, e.g. send for a recount by cancelling or counting again in a new stocktake).
 * Separation of duties: the person who submitted the count cannot approve it, unless they are the OWNER.
 */
async function approveStocktake(businessId, user, id, { rejectLineIds = [], note } = {}) {
  return inTx(async (session) => {
    const doc = await Stocktake.findOne({ _id: id, businessId }).session(session);
    if (!doc) throw ApiError.notFound('Stocktake not found');
    if (doc.status !== 'SUBMITTED') throw ApiError.conflict(`Stocktake is ${doc.status}, not SUBMITTED`, 'INVALID_STOCKTAKE_STATE');
    if (String(doc.submittedBy) === String(user._id) && user.role !== 'OWNER') {
      throw ApiError.forbidden('The person who submitted the count cannot approve it. Ask another manager or the owner.', 'SELF_APPROVAL_NOT_ALLOWED');
    }
    const rejected = new Set(rejectLineIds.map(String));
    let net = 0;

    for (const line of doc.lines) {
      if (line.countedQty == null) continue;
      if (rejected.has(String(line._id))) { line.decision = 'REJECTED'; continue; }
      if (line.varianceQty === 0) { line.decision = 'APPROVED'; continue; }

      const delta = line.varianceQty;
      const reason = `Stocktake ${doc.stocktakeNumber}: counted ${line.countedQty}, system ${line.systemQtyAtCount}`;

      if (line.batchId) {
        // Batch line: change the batch and sellable stock together. Refuse if the batch changed state or cannot cover a loss.
        const filter = { _id: line.batchId, businessId, status: 'active' };
        if (delta < 0) filter.quantity = { $gte: -delta };
        const b = await Batch.findOneAndUpdate(filter, { $inc: { quantity: delta } }, { new: true, session });
        if (!b) throw ApiError.conflict(`${line.nameSnapshot} (batch ${line.batchNumber}) changed since it was counted. Recount it before approving.`, 'STOCK_CHANGED_SINCE_COUNT');
        if (b.quantity <= 0 && b.status === 'active') { b.status = 'depleted'; await b.save({ session }); }
      }
      await applyStockChange({
        businessId, branchId: doc.branchId, productId: line.productId, variantId: line.variantId || null,
        quantityDelta: delta, type: delta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT', referenceType: 'Stocktake', referenceId: doc._id,
        reason, performedBy: user._id, session, allowNegative: true,
      });
      line.decision = 'APPROVED';
      net += line.varianceValue;
    }

    doc.status = 'APPROVED'; doc.approvedBy = user._id; doc.approvedAt = new Date(); doc.approvalNote = note; doc.totalVarianceValue = net;
    await doc.save({ session });
    await AuditLog.create([{ businessId, branchId: doc.branchId, userId: user._id, action: 'stocktake.approve', entityType: 'Stocktake', entityId: doc._id, newValue: { netVarianceCents: net, rejectedLines: rejected.size } }], { session });
    return doc;
  });
}

async function cancelStocktake(businessId, userId, id, { reason }) {
  const doc = await Stocktake.findOne({ _id: id, businessId });
  if (!doc) throw ApiError.notFound('Stocktake not found');
  if (!['OPEN', 'SUBMITTED'].includes(doc.status)) throw ApiError.conflict(`Stocktake is ${doc.status}`, 'INVALID_STOCKTAKE_STATE');
  doc.status = 'CANCELLED'; doc.cancelledBy = userId; doc.cancelReason = reason;
  await doc.save();
  await AuditLog.create({ businessId, branchId: doc.branchId, userId, action: 'stocktake.cancel', entityType: 'Stocktake', entityId: doc._id, newValue: { reason } });
  return doc;
}

module.exports = { createStocktake, listStocktakes, getStocktake, recordCounts, submitStocktake, approveStocktake, cancelStocktake };