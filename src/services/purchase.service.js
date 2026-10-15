const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Supplier = require('../models/Supplier');
const Business = require('../models/Business');
const batchService = require('./batch.service');
const serialService = require('./serial.service');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange } = require('./inventory.service');
const { resolveWarehouse } = require('./warehouse.resolver');
const { resolveUnit } = require('../utils/units');

const round3 = (n) => Math.round(n * 1000) / 1000;

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
  { supplierId, invoiceNumber, invoiceDate, dueDate, warehouseId, items, purchaseDate, notes, vatMode = 'NONE', vatRate = 0 },
  files
) {
  const supplier = await Supplier.findOne({ _id: supplierId, businessId });
  if (!supplier) throw ApiError.badRequest('Supplier not found', 'INVALID_SUPPLIER');

  const biz = await Business.findById(businessId).select('featureSettings');
  if (warehouseId) await resolveWarehouse(businessId, { warehouseId }); // must exist and be active
  const products = await Product.find({ businessId, _id: { $in: items.map((i) => i.productId) } });
  const productById = new Map(products.map((p) => [p._id.toString(), p]));

  let subtotal = 0;
  let discountTotal = 0;
  let total = 0;
  const priceUpdates = [];

  const builtItems = items.map((raw) => {
    const product = productById.get(raw.productId.toString());
    if (!product) throw ApiError.badRequest(`Product not found: ${raw.productId}`, 'PRODUCT_NOT_FOUND');

    // Unit conversion: quantity and unitCost are per PURCHASE unit (10 bundles @ 1,200); stock gets quantity x factor base units.
    const unit = resolveUnit(product, raw.unitId);
    if (!unit.isBase && !biz?.featureSettings?.unitConversions) throw ApiError.forbidden('Unit conversion is not enabled for your business', 'FEATURE_DISABLED');
    const line = computeLine(raw);
    subtotal += line.gross;
    discountTotal += raw.discount || 0;
    total += line.total;

    if (raw.updatePrices) {
      // Real unit cost = what the line actually costs per unit incl. VAT.
      const realUnitCost = Math.round(line.total / (raw.quantity * unit.factor)); // cost per BASE unit
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
      quantity: raw.quantity, unitId: unit.id || undefined, unitName: unit.name, unitFactor: unit.factor, unitCost: raw.unitCost, taxRate: raw.taxRate || 0, discount: raw.discount || 0,
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
        businessId, branchId, supplierId, purchaseNumber, invoiceNumber, invoiceDate, warehouseId,
        dueDate: dueDate || (supplier.paymentTermsDays ? new Date((invoiceDate ? new Date(invoiceDate).getTime() : Date.now()) + supplier.paymentTermsDays * 86400000) : undefined),
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
 *
 * WHERE the goods go: `location` is the default pool for the whole receipt ('RETAIL' = shop floor, the original
 * behaviour, or 'WAREHOUSE' = wholesale store). `lineLocations` overrides it per line, e.g.
 * [{ productId, variantId?, location: 'WAREHOUSE' }]. Stock, batches and serials of a line all land in the SAME
 * pool, and the pool is stored on the purchase line, the ledger rows and the batch/serial records.
 * To split one line between warehouse and retail: receive it into the warehouse, then move part to retail with
 * warehouse.service#transferBetweenLocations (both steps are fully traced).
 */
async function receivePurchase(businessId, userId, id, batchLines = [], serialLines = [], { location = 'RETAIL', lineLocations = [], warehouseId = null } = {}) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const purchase = await Purchase.findOne({ _id: id, businessId }).session(session);
      if (!purchase) throw ApiError.notFound('Purchase not found');
      if (purchase.receivedStatus === 'RECEIVED') throw ApiError.conflict('This purchase has already been fully received', 'ALREADY_RECEIVED');

      // Businesses with batch tracking on MUST supply the supplier's real batch number (and expiry where the
      // product tracks it) for every batch-tracked line. Others keep the old behaviour (batch = purchase number).
      const biz = await Business.findById(businessId).select('featureSettings').session(session);
      const strictBatches = !!biz?.featureSettings?.batchTracking;
      const wantsWarehouse = location === 'WAREHOUSE' || (lineLocations || []).some((l) => l.location === 'WAREHOUSE');
      if (wantsWarehouse && !biz?.featureSettings?.multiWarehouse) {
        throw ApiError.forbidden('Warehouse stock is not enabled for your business (multiWarehouse)', 'FEATURE_DISABLED');
      }

      for (const item of purchase.items) {
        const outstanding = item.quantity - item.receivedQuantity;
        if (outstanding <= 0) continue;

        const product = await Product.findOne({ _id: item.productId, businessId }).session(session);
        const lineCfg = (lineLocations || []).find((l) => String(l.productId) === String(item.productId)
          && String(l.variantId || '') === String(item.variantId || ''));
        const lineLoc = lineCfg?.location || location;
        // which warehouse: the line's, else the receipt's, else the purchase's, else the branch's default
        const lineWh = lineLoc === 'WAREHOUSE'
          ? (await resolveWarehouse(businessId, { warehouseId: lineCfg?.warehouseId || warehouseId || purchase.warehouseId, branchId: purchase.branchId, userId, session }))
          : null;
        item.receivedLocation = lineLoc;
        item.receivedWarehouseId = lineWh?._id;
        // unit conversion: stock moves in BASE units, cost per base unit
        const factor = item.unitFactor || 1;
        const baseOutstanding = round3(outstanding * factor);
        const baseUnitCost = Math.round(item.unitCost / factor);
        if (product?.trackInventory) {
          await applyStockChange({
            businessId, branchId: purchase.branchId, productId: item.productId, variantId: item.variantId || null,
            quantityDelta: baseOutstanding, warehouseId: lineWh?._id || null, type: 'PURCHASE', referenceType: 'Purchase', referenceId: purchase._id,
            reason: `Purchase ${purchase.purchaseNumber} received${lineLoc === 'WAREHOUSE' ? ' (warehouse)' : ''}`, performedBy: userId, session, location: lineLoc,
          });
        }

        // Serialised products (phones, laptops...): every unit must be registered with its serial / IMEI on receipt,
        // otherwise it could never be sold or traced.
        if (product?.trackSerialNumber) {
          const entries = (serialLines || []).filter((l) => String(l.productId) === String(item.productId)
            && String(l.variantId || '') === String(item.variantId || ''));
          const serials = entries.flatMap((e) => e.serialNumbers || []);
          if (!serials.length) throw ApiError.badRequest(`${product.name}: serial number(s) / IMEI(s) are required to receive this line`, 'SERIAL_DETAILS_REQUIRED');
          await serialService.registerSerials({
            businessId, branchId: purchase.branchId, userId, product, variantId: item.variantId || null, quantity: baseOutstanding,
            serials, purchaseId: purchase._id, supplierId: purchase.supplierId, costPrice: baseUnitCost,
            condition: entries[0]?.condition || 'new', session, location: lineLoc,
          });
        }

        if (product?.trackBatch) {
          const lines = (batchLines || []).filter((l) => String(l.productId) === String(item.productId)
            && String(l.variantId || '') === String(item.variantId || ''));

          if (!lines.length) {
            if (strictBatches) {
              throw ApiError.badRequest(`${product.name}: supplier batch number${product.trackExpiry ? ' and expiry date are' : ' is'} required to receive this line`, 'BATCH_DETAILS_REQUIRED');
            }
            await batchService.receiveIntoBatch({
              businessId, branchId: purchase.branchId, product, variantId: item.variantId || null, quantity: baseOutstanding,
              batchNumber: purchase.purchaseNumber, costPrice: baseUnitCost, supplierId: purchase.supplierId, purchaseId: purchase._id,
              session, legacy: true, location: lineLoc,
            });
          } else {
            const qtys = lines.map((l) => (l.quantity != null ? l.quantity : (lines.length === 1 ? outstanding : null)));
            if (qtys.some((q) => q == null || q <= 0)) throw ApiError.badRequest(`${product.name}: give a quantity for each batch`, 'BATCH_QUANTITY_REQUIRED');
            const sum = Math.round(qtys.reduce((s, q) => s + q, 0) * 1000) / 1000;
            if (sum !== Math.round(outstanding * 1000) / 1000) {
              throw ApiError.badRequest(`${product.name}: batch quantities (${sum}) must add up to the quantity received (${outstanding})`, 'BATCH_QUANTITY_MISMATCH');
            }
            for (let i = 0; i < lines.length; i += 1) {
              await batchService.receiveIntoBatch({
                businessId, branchId: purchase.branchId, product, variantId: item.variantId || null, quantity: round3(qtys[i] * factor),
                batchNumber: lines[i].batchNumber, expiryDate: lines[i].expiryDate, manufacturingDate: lines[i].manufacturingDate,
                costPrice: baseUnitCost, supplierId: purchase.supplierId, purchaseId: purchase._id, session, location: lineLoc,
              });
            }
          }
        }

        item.receivedQuantity = item.quantity;
      }

      purchase.receivedStatus = 'RECEIVED';
      purchase.markModified('items');
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