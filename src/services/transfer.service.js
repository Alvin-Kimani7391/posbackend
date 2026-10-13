const mongoose = require('mongoose');
const StockTransfer = require('../models/StockTransfer');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Business = require('../models/Business');
const batchService = require('./batch.service');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange } = require('./inventory.service');
const User = require('../models/User');
const notificationService = require('./notification.service');

async function listTransfers(businessId, { page, limit, branchId, status }) {
  const filter = { businessId };
  if (branchId) filter.$or = [{ fromBranchId: branchId }, { toBranchId: branchId }];
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    StockTransfer.find(filter)
      .populate('fromBranchId', 'name code')
      .populate('toBranchId', 'name code')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    StockTransfer.countDocuments(filter),
  ]);

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getTransfer(businessId, id) {
  const transfer = await StockTransfer.findOne({ _id: id, businessId })
    .populate('fromBranchId', 'name code')
    .populate('toBranchId', 'name code')
    .populate('items.productId', 'name sku');
  if (!transfer) throw ApiError.notFound('Transfer not found');
  return transfer;
}

/** Stage 1: request a transfer. Does NOT move stock yet - just records intent. */
async function requestTransfer(businessId, userId, { fromBranchId, toBranchId, items, notes }) {
  if (fromBranchId === toBranchId) {
    throw ApiError.badRequest('Source and destination branch must be different', 'INVALID_TRANSFER');
  }

  // Tenant safety: both branches and every product must belong to THIS business.
  const branchCount = await Branch.countDocuments({ businessId, _id: { $in: [fromBranchId, toBranchId] } });
  if (branchCount !== 2) throw ApiError.badRequest('Source or destination branch not found', 'INVALID_TRANSFER');
  const uniqueProductIds = [...new Set(items.map((i) => i.productId.toString()))];

  // Snapshot product names for display even if a product is later renamed/archived.
  const products = await Product.find({ businessId, _id: { $in: uniqueProductIds } });
  if (products.length !== uniqueProductIds.length) throw ApiError.badRequest('One or more products were not found', 'INVALID_TRANSFER');
  const nameById = new Map(products.map((p) => [p._id.toString(), p.name]));

  const seq = await nextSequence(businessId, 'transfer:business', undefined);
  const transferNumber = `TRF-${pad(seq)}`;

  const transfer = await StockTransfer.create({
    businessId,
    transferNumber,
    fromBranchId,
    toBranchId,
    items: items.map((i) => ({ ...i, nameSnapshot: nameById.get(i.productId.toString()) || 'Unknown product' })),
    status: 'REQUESTED',
    requestedBy: userId,
    notes,
  });

  await AuditLog.create({ businessId, userId, action: 'transfer.request', entityType: 'StockTransfer', entityId: transfer._id, newValue: { transferNumber, itemCount: items.length } });

  const requester = await User.findById(userId).select('name');
  notificationService.notifyTransferRequested(businessId, transfer, requester)
    .catch((err) => console.error('notifyTransferRequested failed', err));

  return transfer;
}

/** Stage 2: a manager/owner at the source (or business-wide) approves the request. Still no stock movement. */
async function approveTransfer(businessId, userId, id) {
  const transfer = await StockTransfer.findOne({ _id: id, businessId });
  if (!transfer) throw ApiError.notFound('Transfer not found');
  if (transfer.status !== 'REQUESTED') {
    throw ApiError.conflict(`Cannot approve a transfer in status ${transfer.status}`, 'INVALID_TRANSFER_STATE');
  }

  transfer.status = 'APPROVED';
  transfer.approvedBy = userId;
  await transfer.save();

  await AuditLog.create({ businessId, userId, action: 'transfer.approve', entityType: 'StockTransfer', entityId: transfer._id });
  return transfer;
}

/**
 * Stage 3: goods physically leave the source branch. This is where stock
 * actually decrements at the source - it is now "in transit" and not
 * available at either branch, which is what prevents double-counting
 * (spec section 37): it has left fromBranch's BranchInventory but hasn't
 * yet been added to toBranch's.
 */
async function dispatchTransfer(businessId, userId, id) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      // Re-read INSIDE the transaction so two simultaneous dispatches cannot both take the stock.
      const transfer = await StockTransfer.findOne({ _id: id, businessId }).session(session);
      if (!transfer) throw ApiError.notFound('Transfer not found');
      if (transfer.status !== 'APPROVED') {
        throw ApiError.conflict(`Cannot dispatch a transfer in status ${transfer.status}`, 'INVALID_TRANSFER_STATE');
      }
      const business = await Business.findById(businessId).select('featureSettings').session(session);
      const strict = !!business?.featureSettings?.quarantineManagement;

      for (const item of transfer.items) {
        await applyStockChange({
          businessId,
          branchId: transfer.fromBranchId,
          productId: item.productId,
          variantId: item.variantId || null,
          quantityDelta: -item.quantity,
          type: 'TRANSFER_OUT',
          referenceType: 'StockTransfer',
          referenceId: transfer._id,
          reason: `Transfer ${transfer.transferNumber} dispatched`,
          performedBy: userId,
          session,
        });

        // Batch-tracked goods leave from real, in-date batches (FEFO); expired/held stock cannot be transferred.
        const product = await Product.findOne({ _id: item.productId, businessId }).session(session);
        if (product?.trackBatch) {
          item.batchAllocations = await batchService.allocateForSale({
            businessId, branchId: transfer.fromBranchId, productId: item.productId, variantId: item.variantId || null,
            quantity: item.quantity, allowUnbatchedRemainder: !strict, productName: item.nameSnapshot || product.name, session,
          });
        }
      }

      transfer.status = 'IN_TRANSIT';
      transfer.markModified('items');
      await transfer.save({ session });

      await AuditLog.create([{ businessId, userId, action: 'transfer.dispatch', entityType: 'StockTransfer', entityId: transfer._id }], { session });
      result = transfer;
    });
    return result;
  } finally {
    session.endSession();
  }
}

/** Stage 4: destination branch confirms receipt - stock lands in toBranch's BranchInventory. */
async function receiveTransfer(businessId, userId, id) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const transfer = await StockTransfer.findOne({ _id: id, businessId }).session(session);
      if (!transfer) throw ApiError.notFound('Transfer not found');
      if (transfer.status !== 'IN_TRANSIT') {
        throw ApiError.conflict(`Cannot receive a transfer in status ${transfer.status}`, 'INVALID_TRANSFER_STATE');
      }

      for (const item of transfer.items) {
        await applyStockChange({
          businessId,
          branchId: transfer.toBranchId,
          productId: item.productId,
          variantId: item.variantId || null,
          quantityDelta: item.quantity,
          type: 'TRANSFER_IN',
          referenceType: 'StockTransfer',
          referenceId: transfer._id,
          reason: `Transfer ${transfer.transferNumber} received`,
          performedBy: userId,
          session,
        });

        // Recreate the same batches at the destination (same number, expiry and cost). Stock that expired
        // in transit still lands (it is real stock) but cannot be sold, and shows up in the expiry report.
        if (item.batchAllocations?.length) {
          const product = await Product.findOne({ _id: item.productId, businessId }).session(session);
          for (const a of item.batchAllocations) {
            await batchService.receiveIntoBatch({
              businessId, branchId: transfer.toBranchId, product, variantId: item.variantId || null,
              quantity: a.quantity, batchNumber: a.batchNumber, expiryDate: a.expiryDate,
              manufacturingDate: a.manufacturingDate, costPrice: a.unitCostCents, session, allowExpired: true, legacy: !a.expiryDate,
            });
          }
        }
      }

      transfer.status = 'RECEIVED';
      transfer.receivedBy = userId;
      await transfer.save({ session });

      await AuditLog.create([{ businessId, userId, action: 'transfer.receive', entityType: 'StockTransfer', entityId: transfer._id }], { session });
      result = transfer;
    });
    return result;
  } finally {
    session.endSession();
  }
}

/** Cancel - only allowed before goods have left the source (REQUESTED/APPROVED). Once IN_TRANSIT, it must be received then handled as a return/adjustment. */
async function cancelTransfer(businessId, userId, id) {
  const transfer = await StockTransfer.findOne({ _id: id, businessId });
  if (!transfer) throw ApiError.notFound('Transfer not found');
  if (!['REQUESTED', 'APPROVED'].includes(transfer.status)) {
    throw ApiError.conflict('Only a requested or approved transfer can be cancelled', 'INVALID_TRANSFER_STATE');
  }

  transfer.status = 'CANCELLED';
  await transfer.save();

  await AuditLog.create({ businessId, userId, action: 'transfer.cancel', entityType: 'StockTransfer', entityId: transfer._id });
  return transfer;
}

module.exports = { listTransfers, getTransfer, requestTransfer, approveTransfer, dispatchTransfer, receiveTransfer, cancelTransfer };