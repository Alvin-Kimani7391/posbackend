const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Batch = require('../models/Batch');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange } = require('./inventory.service');

/**
 * Unlike a Sale, a Purchase's unitCost IS legitimate direct input - it's
 * literally what the business paid the supplier, and there is no other
 * "authoritative" source to check it against. What's still computed
 * server-side, never trusted raw from the client, is every DERIVED number:
 * each line's total, and the purchase's subtotal/tax/grand total.
 */
function computeLine({ quantity, unitCost, discount = 0, taxRate = 0 }) {
  const gross = Math.round(quantity * unitCost);
  const net = gross - discount;
  const taxAmount = Math.round(net * (taxRate / 100));
  return { gross, total: net + taxAmount };
}

async function createPurchase(businessId, branchId, userId, { supplierId, invoiceNumber, items, purchaseDate, notes }) {
  const supplier = await Supplier.findOne({ _id: supplierId, businessId });
  if (!supplier) throw ApiError.badRequest('Supplier not found', 'INVALID_SUPPLIER');

  const products = await Product.find({ businessId, _id: { $in: items.map((i) => i.productId) } });
  const productById = new Map(products.map((p) => [p._id.toString(), p]));

  let subtotal = 0;
  let discountTotal = 0;
  let total = 0;

  const builtItems = items.map((raw) => {
    const product = productById.get(raw.productId.toString());
    if (!product) throw ApiError.badRequest(`Product not found: ${raw.productId}`, 'PRODUCT_NOT_FOUND');

    const line = computeLine(raw);
    subtotal += line.gross;
    discountTotal += raw.discount || 0;
    total += line.total;

    return {
      productId: raw.productId, variantId: raw.variantId, nameSnapshot: product.name,
      quantity: raw.quantity, unitCost: raw.unitCost, taxRate: raw.taxRate || 0, discount: raw.discount || 0,
      total: line.total, receivedQuantity: 0,
    };
  });

  const seq = await nextSequence(businessId, 'purchase:business', undefined);
  const purchaseNumber = `PO-${pad(seq)}`;

  const purchase = await Purchase.create({
    businessId, branchId, supplierId, purchaseNumber, invoiceNumber,
    items: builtItems, subtotal, discount: discountTotal, tax: total - subtotal + discountTotal, total,
    amountPaid: 0, balance: total, paymentStatus: 'UNPAID',
    purchaseDate, notes, createdBy: userId,
  });

  await AuditLog.create({ businessId, branchId, userId, action: 'purchase.create', entityType: 'Purchase', entityId: purchase._id, newValue: { purchaseNumber, total } });
  return purchase;
}

async function getPurchase(businessId, id) {
  const purchase = await Purchase.findOne({ _id: id, businessId }).populate('supplierId', 'name phone');
  if (!purchase) throw ApiError.notFound('Purchase not found');
  return purchase;
}

async function listPurchases(businessId, { branchId, supplierId, receivedStatus, paymentStatus, page, limit, search }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (supplierId) filter.supplierId = supplierId;
  if (receivedStatus) filter.receivedStatus = receivedStatus;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (search) filter.purchaseNumber = new RegExp(search, 'i');

  const [items, total] = await Promise.all([
    Purchase.find(filter).populate('supplierId', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Purchase.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * receivePurchase - goods physically arrive. Increments branch inventory
 * (and batches, where the product tracks them) for every line still owed,
 * and adds the payable amount to the supplier's balance. Fully atomic.
 */
async function receivePurchase(businessId, userId, id) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const purchase = await Purchase.findOne({ _id: id, businessId }).session(session);
      if (!purchase) throw ApiError.notFound('Purchase not found');
      if (purchase.receivedStatus === 'RECEIVED') throw ApiError.conflict('This purchase has already been fully received', 'ALREADY_RECEIVED');

      for (const item of purchase.items) {
        const outstanding = item.quantity - item.receivedQuantity;
        if (outstanding <= 0) continue;

        const product = await Product.findOne({ _id: item.productId, businessId }).session(session);
        if (product?.trackInventory) {
          await applyStockChange({
            businessId, branchId: purchase.branchId, productId: item.productId, variantId: item.variantId || null,
            quantityDelta: outstanding, type: 'PURCHASE', referenceType: 'Purchase', referenceId: purchase._id,
            reason: `Purchase ${purchase.purchaseNumber} received`, performedBy: userId, session,
          });
        }

        if (product?.trackBatch) {
          await Batch.findOneAndUpdate(
            { businessId, branchId: purchase.branchId, productId: item.productId, batchNumber: purchase.purchaseNumber },
            { $inc: { quantity: outstanding }, $setOnInsert: { variantId: item.variantId || null, costPrice: item.unitCost } },
            { upsert: true, session }
          );
        }

        item.receivedQuantity = item.quantity;
      }

      purchase.receivedStatus = 'RECEIVED';
      await purchase.save({ session });

      await Supplier.updateOne({ _id: purchase.supplierId }, { $inc: { currentBalance: purchase.total - purchase.amountPaid } }, { session });

      await AuditLog.create(
        [{ businessId, branchId: purchase.branchId, userId, action: 'purchase.receive', entityType: 'Purchase', entityId: purchase._id }],
        { session }
      );

      result = purchase;
    });
    return result;
  } finally {
    session.endSession();
  }
}

/** Records a payment THIS BUSINESS made to the supplier against a purchase. Reduces both the purchase balance and the supplier's payable. */
async function recordPurchasePayment(businessId, userId, id, { amount }) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const purchase = await Purchase.findOne({ _id: id, businessId }).session(session);
      if (!purchase) throw ApiError.notFound('Purchase not found');
      if (amount > purchase.balance) throw ApiError.badRequest('Payment exceeds the outstanding balance', 'OVERPAYMENT');

      purchase.amountPaid += amount;
      purchase.balance = purchase.total - purchase.amountPaid;
      purchase.paymentStatus = purchase.balance === 0 ? 'PAID' : purchase.amountPaid > 0 ? 'PARTIAL' : 'UNPAID';
      await purchase.save({ session });

      await Supplier.updateOne({ _id: purchase.supplierId }, { $inc: { currentBalance: -amount } }, { session });

      await AuditLog.create(
        [{ businessId, branchId: purchase.branchId, userId, action: 'purchase.payment', entityType: 'Purchase', entityId: purchase._id, newValue: { amount } }],
        { session }
      );

      result = purchase;
    });
    return result;
  } finally {
    session.endSession();
  }
}

module.exports = { createPurchase, getPurchase, listPurchases, receivePurchase, recordPurchasePayment };
