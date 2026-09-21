const mongoose = require('mongoose');
const Refund = require('../models/Refund');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const CustomerLedger = require('../models/CustomerLedger');
const Payment = require('../models/Payment');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange } = require('./inventory.service');

/**
 * requestRefund - validates the return quantities against what's actually
 * still refundable on the sale (quantity - refundedQuantity per line, never
 * allowing a line to be over-returned), computes each line's refund amount
 * PROPORTIONALLY from what was actually charged (not from today's product
 * price), and either auto-completes or leaves it pending manager approval
 * depending on the business's own settings.
 */
async function requestRefund(businessId, branchId, user, { saleId, items, reason, paymentMethod }) {
  const sale = await Sale.findOne({ _id: saleId, businessId });
  if (!sale) throw ApiError.notFound('Sale not found');
  if (sale.saleStatus !== 'COMPLETED') throw ApiError.conflict('Only a completed sale can be refunded', 'INVALID_SALE_STATE');

  const business = await Business.findById(businessId);

  const builtItems = items.map((raw) => {
    const saleItem = sale.items.find((si) => si.productId.toString() === raw.productId.toString() && (si.variantId ? si.variantId.toString() : null) === (raw.variantId || null));
    if (!saleItem) throw ApiError.badRequest('This item was not part of the original sale', 'ITEM_NOT_IN_SALE');

    const remaining = saleItem.quantity - saleItem.refundedQuantity;
    if (raw.quantity > remaining) {
      throw ApiError.badRequest(`Cannot refund ${raw.quantity} of ${saleItem.nameSnapshot} - only ${remaining} remain refundable`, 'REFUND_EXCEEDS_SOLD_QUANTITY');
    }

    // Proportional to what was actually charged for this line (post
    // discount/tax), never recomputed from today's product price.
    const amount = Math.round((saleItem.total / saleItem.quantity) * raw.quantity);

    return { productId: saleItem.productId, variantId: saleItem.variantId, nameSnapshot: saleItem.nameSnapshot, quantity: raw.quantity, amount };
  });

  const totalAmount = builtItems.reduce((s, i) => s + i.amount, 0);
  const seq = await nextSequence(businessId, 'refund:business', undefined);
  const refundNumber = `RFD-${pad(seq)}`;

  const needsApproval = !!business?.settings?.requireManagerRefundApproval && !userCanApprove(user);

  const refund = await Refund.create({
    businessId, branchId, saleId: sale._id, customerId: sale.customerId,
    refundNumber, items: builtItems, amount: totalAmount, reason, paymentMethod,
    status: needsApproval ? 'REQUESTED' : 'APPROVED',
    requestedBy: user._id,
  });

  await AuditLog.create({ businessId, branchId, userId: user._id, action: 'refund.request', entityType: 'Refund', entityId: refund._id, newValue: { refundNumber, amount: totalAmount, needsApproval } });

  if (!needsApproval) {
    return completeRefund(businessId, user._id, refund._id);
  }
  return refund;
}

function userCanApprove(user) {
  // Mirrors the 'refunds.approve' default grants (OWNER/ADMIN/MANAGER) -
  // kept here as a plain role check since this runs before the request
  // has been approved by anyone, i.e. it's evaluating the REQUESTER's own
  // standing, not a separate approver.
  return ['OWNER', 'ADMIN', 'MANAGER'].includes(user.role);
}

async function approveRefund(businessId, userId, id) {
  const refund = await Refund.findOne({ _id: id, businessId });
  if (!refund) throw ApiError.notFound('Refund not found');
  if (refund.status !== 'REQUESTED') throw ApiError.conflict('This refund has already been decided', 'ALREADY_DECIDED');

  refund.approvedBy = userId;
  await refund.save();

  return completeRefund(businessId, userId, refund._id);
}

async function rejectRefund(businessId, userId, id, rejectionReason) {
  const refund = await Refund.findOne({ _id: id, businessId });
  if (!refund) throw ApiError.notFound('Refund not found');
  if (refund.status !== 'REQUESTED') throw ApiError.conflict('This refund has already been decided', 'ALREADY_DECIDED');

  refund.status = 'REJECTED';
  refund.approvedBy = userId;
  refund.rejectionReason = rejectionReason;
  await refund.save();

  await AuditLog.create({ businessId, branchId: refund.branchId, userId, action: 'refund.reject', entityType: 'Refund', entityId: refund._id, newValue: { rejectionReason } });
  return refund;
}

/**
 * completeRefund - the actual atomic effect: restore inventory, mark the
 * sale's per-line refundedQuantity so it can never be double-refunded,
 * reverse customer credit if the original sale carried any, and record a
 * Payment representing money paid back out.
 */
async function completeRefund(businessId, userId, refundId) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const refund = await Refund.findOne({ _id: refundId, businessId }).session(session);
      if (!refund) throw ApiError.notFound('Refund not found');

      const sale = await Sale.findOne({ _id: refund.saleId, businessId }).session(session);
      if (!sale) throw ApiError.notFound('Original sale not found');

      for (const rItem of refund.items) {
        const saleItem = sale.items.find((si) => si.productId.toString() === rItem.productId.toString() && (si.variantId ? si.variantId.toString() : null) === (rItem.variantId ? rItem.variantId.toString() : null));
        if (!saleItem) continue;

        // Re-check at completion time too - another refund could have been
        // approved in between this one being requested and approved.
        const remaining = saleItem.quantity - saleItem.refundedQuantity;
        if (rItem.quantity > remaining) {
          throw ApiError.conflict(`${saleItem.nameSnapshot} no longer has enough refundable quantity remaining`, 'REFUND_EXCEEDS_SOLD_QUANTITY');
        }
        saleItem.refundedQuantity += rItem.quantity;

        const product = await Product.findOne({ _id: rItem.productId, businessId }).session(session);
        if (product?.trackInventory) {
          await applyStockChange({
            businessId, branchId: refund.branchId, productId: rItem.productId, variantId: rItem.variantId || null,
            quantityDelta: rItem.quantity, type: 'REFUND', referenceType: 'Refund', referenceId: refund._id,
            reason: `Refund ${refund.refundNumber}`, performedBy: userId, session, allowNegative: true,
          });
        }
      }
      await sale.save({ session });

      const [payment] = await Payment.create(
        [{ businessId, branchId: refund.branchId, saleId: sale._id, refundId: refund._id, customerId: refund.customerId, method: refund.paymentMethod, provider: 'manual', amount: refund.amount, status: 'REFUNDED', initiatedBy: userId, completedAt: new Date() }],
        { session }
      );

      // If the original sale carried customer credit, reduce it - capped so
      // we never push a customer's balance negative from a refund alone.
      if (sale.balance > 0 && refund.customerId) {
        const customer = await Customer.findOne({ _id: refund.customerId, businessId }).session(session);
        if (customer && customer.outstandingBalance > 0) {
          const creditReversal = Math.min(refund.amount, customer.outstandingBalance);
          const newBalance = customer.outstandingBalance - creditReversal;
          await CustomerLedger.create(
            [{ businessId, customerId: customer._id, transactionType: 'REVERSAL', referenceType: 'Refund', referenceId: refund._id, debit: 0, credit: creditReversal, balance: newBalance, createdBy: userId, notes: `Refund ${refund.refundNumber}` }],
            { session }
          );
          await Customer.updateOne({ _id: customer._id }, { $inc: { outstandingBalance: -creditReversal } }, { session });
        }
      }

      refund.status = 'COMPLETED';
      await refund.save({ session });

      await AuditLog.create(
        [{ businessId, branchId: refund.branchId, userId, action: 'refund.complete', entityType: 'Refund', entityId: refund._id, newValue: { amount: refund.amount } }],
        { session }
      );

      result = { refund, payment };
    });
    return result;
  } finally {
    session.endSession();
  }
}

async function listRefunds(businessId, { branchId, saleId, status, page, limit }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (saleId) filter.saleId = saleId;
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    Refund.find(filter).populate('requestedBy', 'name').populate('customerId', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Refund.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getRefund(businessId, id) {
  const refund = await Refund.findOne({ _id: id, businessId }).populate('requestedBy', 'name').populate('approvedBy', 'name').populate('customerId', 'name');
  if (!refund) throw ApiError.notFound('Refund not found');
  return refund;
}

module.exports = { requestRefund, approveRefund, rejectRefund, listRefunds, getRefund };
