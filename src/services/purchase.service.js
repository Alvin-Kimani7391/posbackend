const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
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
 *
 * VAT note: the frontend always sends unitCost as the EX-VAT price plus the
 * taxRate, so the maths below is the same for every VAT mode.
 */
function computeLine({ quantity, unitCost, discount = 0, taxRate = 0 }) {
  const gross = Math.round(quantity * unitCost);
  const net = gross - discount;
  const taxAmount = Math.round(net * (taxRate / 100));
  return { gross, total: net + taxAmount };
}

/** Map multer-storage-cloudinary files to the Purchase.attachments shape. */
const toAttachments = (files = []) =>
  files.map((f) => ({
    url: f.path,
    publicId: f.filename,
    originalName: f.originalname,
    size: f.size,
    mimeType: f.mimetype,
    resourceType: f.mimetype.startsWith('image/') ? 'image' : 'raw',
  }));

/**
 * Applies the optional "update prices with this purchase" requests.
 * Runs INSIDE the purchase transaction, so the purchase and the price
 * changes commit or roll back together.
 *
 * Rules:
 *  - cost price  := the line's REAL unit cost (line total incl. VAT / qty),
 *    which is the same "Real cost per unit" the purchase screen shows.
 *    (To store ex-VAT cost instead, change `realUnitCost` in createPurchase.)
 *  - selling price / default discount: only changed when supplied.
 *  - variant line: variant cost + selling price change; the discount is a
 *    product-level field so it changes on the parent product.
 *  - the discount may never exceed the selling price (checked on merged values).
 * Products are loaded and saved with save() (not raw updates) so the money
 * schema plugin and validators behave exactly as in product.service.
 */
async function applyPriceUpdates({ businessId, branchId, userId, purchase, updates, session }) {
  const audits = [];

  for (const u of updates) {
    const product = await Product.findOne({ _id: u.productId, businessId }).session(session);
    if (!product) throw ApiError.badRequest(`Product not found: ${u.productId}`, 'PRODUCT_NOT_FOUND');

    const oldValue = {};
    const newValue = {};
    let productChanged = false;

    if (u.variantId) {
      const variant = await ProductVariant.findOne({ _id: u.variantId, businessId, productId: product._id }).session(session);
      if (!variant) throw ApiError.badRequest('Variant not found', 'VARIANT_NOT_FOUND');

      oldValue.costPrice = variant.costPrice;
      oldValue.sellingPrice = variant.sellingPrice;
      variant.costPrice = u.costPrice;
      if (u.sellingPrice !== undefined) variant.sellingPrice = u.sellingPrice;
      newValue.costPrice = variant.costPrice;
      newValue.sellingPrice = variant.sellingPrice;

      if (u.defaultDiscount !== undefined && u.defaultDiscount > variant.sellingPrice) {
        throw ApiError.badRequest(`Discount cannot be more than the selling price (${product.name})`, 'INVALID_DISCOUNT');
      }
      await variant.save({ session });
    } else {
      oldValue.costPrice = product.costPrice;
      oldValue.sellingPrice = product.sellingPrice;
      product.costPrice = u.costPrice;
      if (u.sellingPrice !== undefined) product.sellingPrice = u.sellingPrice;
      newValue.costPrice = product.costPrice;
      newValue.sellingPrice = product.sellingPrice;
      productChanged = true;
    }

    if (u.defaultDiscount !== undefined) {
      oldValue.defaultDiscount = product.defaultDiscount;
      product.defaultDiscount = u.defaultDiscount;
      newValue.defaultDiscount = product.defaultDiscount;
      productChanged = true;
    }

    if (!product.hasVariants && (product.defaultDiscount || 0) > (product.sellingPrice || 0)) {
      throw ApiError.badRequest(`Discount cannot be more than the selling price (${product.name})`, 'INVALID_DISCOUNT');
    }

    if (productChanged) {
      product.updatedBy = userId;
      await product.save({ session });
    }

    audits.push({
      businessId, branchId, userId,
      action: u.variantId ? 'product.variant.update' : 'product.update',
      entityType: u.variantId ? 'ProductVariant' : 'Product',
      entityId: u.variantId || product._id,
      oldValue,
      newValue: { ...newValue, source: 'purchase', purchaseNumber: purchase.purchaseNumber },
    });
  }

  if (audits.length) await AuditLog.create(audits, { session, ordered: true });
  return audits.length;
}

async function createPurchase(
  businessId, branchId, userId,
  { supplierId, invoiceNumber, items, purchaseDate, notes, vatMode = 'NONE', vatRate = 0 },
  files
) {
  const supplier = await Supplier.findOne({ _id: supplierId, businessId });
  if (!supplier) throw ApiError.badRequest('Supplier not found', 'INVALID_SUPPLIER');

  const products = await Product.find({ businessId, _id: { $in: items.map((i) => i.productId) } });
  const productById = new Map(products.map((p) => [p._id.toString(), p]));

  let subtotal = 0;
  let discountTotal = 0;
  let total = 0;
  const priceUpdates = [];

  const builtItems = items.map((raw) => {
    const product = productById.get(raw.productId.toString());
    if (!product) throw ApiError.badRequest(`Product not found: ${raw.productId}`, 'PRODUCT_NOT_FOUND');

    const line = computeLine(raw);
    subtotal += line.gross;
    discountTotal += raw.discount || 0;
    total += line.total;

    if (raw.updatePrices) {
      // Real unit cost = what the line actually costs per unit incl. VAT.
      const realUnitCost = Math.round(line.total / raw.quantity);
      priceUpdates.push({
        productId: raw.productId,
        variantId: raw.variantId,
        costPrice: realUnitCost,
        sellingPrice: raw.sellingPrice,
        defaultDiscount: raw.defaultDiscount,
      });
    }

    return {
      productId: raw.productId, variantId: raw.variantId, nameSnapshot: product.name,
      quantity: raw.quantity, unitCost: raw.unitCost, taxRate: raw.taxRate || 0, discount: raw.discount || 0,
      total: line.total, receivedQuantity: 0,
    };
  });

  const seq = await nextSequence(businessId, 'purchase:business', undefined);
  const purchaseNumber = `PO-${pad(seq)}`;

  const session = await mongoose.startSession();
  try {
    let purchase;
    await session.withTransaction(async () => {
      [purchase] = await Purchase.create([{
        businessId, branchId, supplierId, purchaseNumber, invoiceNumber,
        vatMode, vatRate: vatMode === 'NONE' ? 0 : vatRate,
        attachments: toAttachments(files),
        items: builtItems, subtotal, discount: discountTotal, tax: total - subtotal + discountTotal, total,
        amountPaid: 0, balance: total, paymentStatus: 'UNPAID',
        purchaseDate, notes, createdBy: userId,
      }], { session });

      const pricesUpdated = priceUpdates.length
        ? await applyPriceUpdates({ businessId, branchId, userId, purchase, updates: priceUpdates, session })
        : 0;

      await AuditLog.create(
        [{ businessId, branchId, userId, action: 'purchase.create', entityType: 'Purchase', entityId: purchase._id, newValue: { purchaseNumber, total, pricesUpdated } }],
        { session }
      );
    });
    return purchase;
  } finally {
    session.endSession();
  }
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