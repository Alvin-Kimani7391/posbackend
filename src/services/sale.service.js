const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Customer = require('../models/Customer');
const CustomerLedger = require('../models/CustomerLedger');
const Payment = require('../models/Payment');

const mpesaService = require('./mpesa.service');
const etimsService = require('./etims.service');

const Receipt = require('../models/Receipt');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const CashShift = require('../models/CashShift');
const SerialNumber = require('../models/SerialNumber');
const Batch = require('../models/Batch');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange, getStockLevel } = require('./inventory.service');
const { computeLineItem, computeSaleTotals, maxDiscountPercentForRole, canOverridePrice } = require('./sale-pricing.util');

/**
 * createSale - see spec section 17 for the step list this follows exactly:
 * validate -> price on the backend only -> validate stock -> compute totals
 * -> (transaction) create sale -> decrement inventory -> record payments ->
 * update customer credit -> create receipt -> audit log.
 *
 * Money in `payload` arrives already converted to integer cents by the
 * validator layer (see validators/sale.validator.js) - this function never
 * does decimal/float math.
 */
async function createSale(businessId, branchId, cashierUser, payload) {
  // --- Offline-sync / double-submit idempotency: same device replaying the
  // same client-generated transaction id gets back the ORIGINAL sale,
  // never a second one. ---
  if (payload.clientTransactionId && payload.deviceId) {
    const existing = await Sale.findOne({ businessId, branchId, deviceId: payload.deviceId, clientTransactionId: payload.clientTransactionId });
    if (existing) return buildExistingSaleResult(existing);
  }

  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');

  // --- Shift resolution ---
  const hasCashPayment = payload.payments.some((p) => p.method === 'CASH');
  let shift = null;
  if (business.settings.requireShift && hasCashPayment) {
    shift = await CashShift.findOne({ businessId, branchId, cashierId: cashierUser._id, status: 'OPEN' });
    if (!shift) throw ApiError.badRequest('Open a cash shift before taking cash payments', 'SHIFT_REQUIRED');
  } else {
    // Attach an open shift opportunistically (for shift-level reporting)
    // even when not strictly required, e.g. a non-cash sale during a shift.
    shift = await CashShift.findOne({ businessId, branchId, cashierId: cashierUser._id, status: 'OPEN' });
  }

  // --- Customer ---
  let customer = null;
  if (payload.customerId) {
    customer = await Customer.findOne({ _id: payload.customerId, businessId, status: 'active' });
    if (!customer) throw ApiError.badRequest('Customer not found', 'INVALID_CUSTOMER');
  }

  const taxInclusive = !!business.taxSettings?.taxInclusive;
  const maxDiscountPercent = maxDiscountPercentForRole(cashierUser.role, business);

  // --- Price and validate every line SERVER-SIDE. The frontend sends only
  // productId/variantId/quantity(/discount/overridePrice); unitPrice and
  // costPrice always come from the authoritative Product/ProductVariant
  // record fetched here, never from the request body. ---
  const builtItems = [];
  for (const rawItem of payload.items) {
    const product = await Product.findOne({ _id: rawItem.productId, businessId, status: 'active' });
    if (!product) throw ApiError.badRequest(`Product not found: ${rawItem.productId}`, 'PRODUCT_NOT_FOUND');

    let variant = null;
    if (rawItem.variantId) {
      variant = await ProductVariant.findOne({ _id: rawItem.variantId, businessId, productId: product._id, status: 'active' });
      if (!variant) throw ApiError.badRequest('Variant not found', 'VARIANT_NOT_FOUND');
    } else if (product.hasVariants) {
      throw ApiError.badRequest(`${product.name} requires a variant to be selected`, 'VARIANT_REQUIRED');
    }

    let unitPrice = variant ? variant.sellingPrice : product.sellingPrice;
    const costPriceSnapshot = variant ? variant.costPrice : product.costPrice;

    if (rawItem.overridePrice !== undefined && rawItem.overridePrice !== null) {
      if (!canOverridePrice(cashierUser, business)) {
        throw ApiError.forbidden('You are not allowed to override prices', 'PRICE_OVERRIDE_DENIED');
      }
      unitPrice = rawItem.overridePrice;
    }

    const discount = rawItem.discount || 0;
    if (discount > 0 && maxDiscountPercent < 100) {
      const grossForLimit = Math.round(unitPrice * rawItem.quantity);
      const maxAllowed = Math.round((grossForLimit * maxDiscountPercent) / 100);
      if (discount > maxAllowed) {
        throw ApiError.forbidden(`Discount exceeds your limit of ${maxDiscountPercent}%`, 'DISCOUNT_LIMIT_EXCEEDED');
      }
    }

    const computed = computeLineItem({ unitPrice, quantity: rawItem.quantity, discount, taxRate: product.taxRate || 0, taxInclusive });

    if (product.trackSerialNumber) {
      if (!rawItem.serialNumbers || rawItem.serialNumbers.length !== rawItem.quantity) {
        throw ApiError.badRequest(`${product.name} requires exactly ${rawItem.quantity} serial number(s)`, 'SERIAL_COUNT_MISMATCH');
      }
    }

    builtItems.push({
      productId: product._id,
      variantId: variant ? variant._id : undefined,
      nameSnapshot: product.name,
      skuSnapshot: variant ? variant.sku : product.sku,
      barcodeSnapshot: variant ? variant.barcode : product.barcode,
      quantity: rawItem.quantity,
      unitPrice,
      costPriceSnapshot,
      discount,
      taxRate: product.taxRate || 0,
      taxAmount: computed.taxAmount,
      total: computed.lineTotal,
      refundedQuantity: 0,
      batchId: rawItem.batchId || undefined,
      serialNumbers: rawItem.serialNumbers || [],
      _meta: { product, variant, quantity: rawItem.quantity, grossLineTotal: computed.grossLineTotal, discountApplied: discount },
    });
  }

  // --- Cart-level discount, validated against the same role limit ---
  const cartDiscount = payload.cartDiscount || 0;
  const subtotalAfterItemDiscount = builtItems.reduce((s, i) => s + i._meta.grossLineTotal - i._meta.discountApplied, 0);
  if (cartDiscount > 0 && maxDiscountPercent < 100) {
    const maxAllowed = Math.round((subtotalAfterItemDiscount * maxDiscountPercent) / 100);
    if (cartDiscount > maxAllowed) {
      throw ApiError.forbidden(`Cart discount exceeds your limit of ${maxDiscountPercent}%`, 'DISCOUNT_LIMIT_EXCEEDED');
    }
  }

  const totals = computeSaleTotals(
    builtItems.map((i) => ({ grossLineTotal: i._meta.grossLineTotal, taxAmount: i.taxAmount, lineTotal: i.total, discountApplied: i._meta.discountApplied })),
    cartDiscount
  );
  if (totals.total < 0) throw ApiError.badRequest('Discount exceeds the sale total', 'INVALID_DISCOUNT');

  // --- Payments & credit ---
  const payments = payload.payments || [];
  const paidAmount = payments.reduce((s, p) => s + p.amount, 0);
  if (paidAmount > totals.total) throw ApiError.badRequest('Payments exceed the sale total', 'OVERPAYMENT');
  const balance = totals.total - paidAmount;

  let paymentStatus;
  if (balance === 0) paymentStatus = 'PAID';
  else if (paidAmount > 0) paymentStatus = 'PARTIAL';
  else paymentStatus = 'CREDIT';

  if (balance > 0) {
    if (!customer) throw ApiError.badRequest('A customer is required for a credit or partial-payment sale', 'CUSTOMER_REQUIRED_FOR_CREDIT');
    if (!business.settings.enableCustomerCredit) throw ApiError.badRequest('Customer credit is not enabled for this business', 'CREDIT_DISABLED');
    if (!customer.creditLimit || customer.creditLimit <= 0) throw ApiError.badRequest('This customer has no credit limit set', 'NO_CREDIT_LIMIT');
    if (customer.outstandingBalance + balance > customer.creditLimit) {
      throw ApiError.badRequest('This sale would exceed the customer credit limit', 'CREDIT_LIMIT_EXCEEDED');
    }
  }

  // --- Fast-fail stock pre-check (the REAL guarantee is the atomic
  // decrement inside the transaction below; this just avoids opening a
  // transaction for an obviously-doomed request). ---
  for (const item of builtItems) {
    if (item._meta.product.trackInventory && !business.settings.allowNegativeStock) {
      const level = await getStockLevel(businessId, branchId, item.productId, item.variantId || null);
      if (level.availableQuantity < item.quantity) {
        throw ApiError.badRequest(`Insufficient stock for ${item.nameSnapshot} (available: ${level.availableQuantity})`, 'INSUFFICIENT_STOCK');
      }
    }
  }

  // ============================== TRANSACTION ==============================
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const branch = await Branch.findById(branchId).session(session);
      const seq = await nextSequence(businessId, `receipt:branch:${branchId}`, session);
      const receiptNumber = `${business.receiptSettings?.receiptPrefix || 'RCT'}-${branch?.code || 'MAIN'}-${pad(seq)}`;
      const invoiceNumber = `${business.receiptSettings?.invoicePrefix || 'INV'}-${pad(seq)}`;

      const [sale] = await Sale.create(
        [{
          businessId, branchId, receiptNumber, invoiceNumber,
          customerId: customer?._id, cashierId: cashierUser._id, shiftId: shift?._id,
          items: builtItems.map(({ _meta, ...rest }) => rest),
          subtotal: totals.subtotal, itemDiscount: totals.itemDiscount, cartDiscount, tax: totals.tax, total: totals.total,
          amountPaid: paidAmount, balance, paymentStatus, saleStatus: 'COMPLETED', source: 'POS',
          notes: payload.notes, clientTransactionId: payload.clientTransactionId, deviceId: payload.deviceId,
        }],
        { session }
      );

      // Resolve MPESA lines against verified MpesaTransactions before building
      // payment docs. CASH/CARD/BANK stay exactly as before (cashier-attested).
      for (const p of payments) {
        if (p.method === 'MPESA') {
          if (!p.reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED');
          const confirmed = await mpesaService.consumeForSale(businessId, p.reference, p.amount, sale._id, session);
          p.provider = 'payhero';
          p.externalTransactionId = confirmed.externalTransactionId; // may be null if the receipt number hasn't arrived via callback yet - see mpesaService.handleCallback's backfill
          p.metadata = { checkoutRequestId: confirmed.checkoutRequestId };
        }
      }

      // Inventory, serials, batches - one item at a time, same transaction.
      for (const item of builtItems) {
        const { product, quantity } = item._meta;

        if (product.trackInventory) {
          await applyStockChange({
            businessId, branchId, productId: item.productId, variantId: item.variantId || null,
            quantityDelta: -quantity, type: 'SALE', referenceType: 'Sale', referenceId: sale._id,
            reason: `Sale ${receiptNumber}`, performedBy: cashierUser._id, session,
            allowNegative: business.settings.allowNegativeStock,
          });
        }

        if (product.trackSerialNumber && item.serialNumbers?.length) {
          for (const sn of item.serialNumbers) {
            const updated = await SerialNumber.findOneAndUpdate(
              { businessId, serialNumber: sn, status: 'in_stock' },
              { status: 'sold', saleId: sale._id },
              { session, new: true }
            );
            if (!updated) throw ApiError.badRequest(`Serial number ${sn} is not available`, 'SERIAL_NOT_AVAILABLE');
          }
        }

        if (item.batchId) {
          const updatedBatch = await Batch.findOneAndUpdate(
            { _id: item.batchId, businessId, quantity: { $gte: quantity } },
            { $inc: { quantity: -quantity } },
            { session, new: true }
          );
          if (!updatedBatch) throw ApiError.badRequest(`Insufficient batch stock for ${item.nameSnapshot}`, 'INSUFFICIENT_BATCH_STOCK');
        }
      }

      // Payments - manual recording for CASH/CARD/BANK; MPESA picks up
      // provider/externalTransactionId/metadata resolved above. Swapping in
      // a real gateway for another method later means adding a provider
      // integration that calls this same Payment.create shape from a
      // callback instead of here.
      const paymentDocsInput = payments.map((p) => {
        const doc = {
          businessId, branchId, saleId: sale._id, customerId: customer?._id, shiftId: shift?._id,
          method: p.method, provider: p.provider || 'manual', amount: p.amount, reference: p.reference,
          externalTransactionId: p.externalTransactionId, metadata: p.metadata,
          initiatedBy: cashierUser._id, status: 'SUCCESS', completedAt: new Date(),
        };
        if (p.method === 'CASH') {
          doc.amountTendered = p.amountTendered ?? p.amount;
          doc.changeGiven = Math.max(0, (p.amountTendered ?? p.amount) - p.amount);
        }
        return doc;
      });
      const createdPayments = paymentDocsInput.length ? await Payment.create(paymentDocsInput, { session }) : [];

      // Customer credit ledger - never overwrite Customer.outstandingBalance
      // directly; every change is a ledger entry plus a matching $inc.
      if (balance > 0 && customer) {
        const newBalance = customer.outstandingBalance + balance;
        await CustomerLedger.create(
          [{ businessId, customerId: customer._id, transactionType: 'SALE_CREDIT', referenceType: 'Sale', referenceId: sale._id, debit: balance, credit: 0, balance: newBalance, createdBy: cashierUser._id }],
          { session }
        );
        await Customer.updateOne({ _id: customer._id }, { $inc: { outstandingBalance: balance } }, { session });
      }

      // Immutable receipt snapshot - a printer/PDF/SMS renderer needs only
      // this document. `business` here is a snapshot of receiptSettings AS
      // THEY WERE at sale time, so an owner changing them later never
      // rewrites a historical receipt.
      const [receipt] = await Receipt.create(
        [{
          businessId, branchId, saleId: sale._id, receiptNumber, invoiceNumber,
          receiptData: {
            business: {
              name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin,
              footerMessage: business.receiptSettings?.footerMessage,
              headerMessage: business.receiptSettings?.headerMessage,
              logo: business.receiptSettings?.showLogo ? business.logo : undefined,
              showKraPin: business.receiptSettings?.showKraPin ?? true,
              showCashierName: business.receiptSettings?.showCashierName ?? true,
              showMpesaReceiptCode: business.receiptSettings?.showMpesaReceiptCode ?? true,
              customLines: business.receiptSettings?.customLines || [],
              paperWidth: business.receiptSettings?.paperWidth || '80mm',
            },
            branch: { name: branch?.name, phone: branch?.phone },
            cashier: { name: cashierUser.name },
            customer: customer ? { name: customer.name, phone: customer.phone } : null,
            items: builtItems.map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount, taxRate: i.taxRate, taxAmount: i.taxAmount, total: i.total })),
            subtotal: totals.subtotal, itemDiscount: totals.itemDiscount, cartDiscount, tax: totals.tax, total: totals.total,
            payments: paymentDocsInput.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference, externalTransactionId: p.externalTransactionId })),
            amountTendered: paymentDocsInput.filter((p) => p.method === 'CASH').reduce((s, p) => s + (p.amountTendered || 0), 0),
            changeGiven: paymentDocsInput.filter((p) => p.method === 'CASH').reduce((s, p) => s + (p.changeGiven || 0), 0),
            balance, paymentStatus,
          },
        }],
        { session }
      );

      await AuditLog.create(
        [{ businessId, branchId, userId: cashierUser._id, action: 'sale.create', entityType: 'Sale', entityId: sale._id, newValue: { receiptNumber, total: totals.total, paymentStatus } }],
        { session }
      );

      // eTIMS: enqueue only - never let a slow/down KRA endpoint block checkout.
      // Does nothing if eTIMS isn't enabled for this business (checked inside).
      await etimsService.enqueueForSale(businessId, branchId, sale._id, { session });

      result = { sale, receipt, payments: createdPayments };
    });
    return result;
  } finally {
    session.endSession();
  }
}

async function buildExistingSaleResult(sale) {
  const [receipt, payments] = await Promise.all([
    Receipt.findOne({ saleId: sale._id }),
    Payment.find({ saleId: sale._id }),
  ]);
  return { sale, receipt, payments, replayed: true };
}

async function getSale(businessId, id) {
  const sale = await Sale.findOne({ _id: id, businessId })
    .populate('customerId', 'name phone')
    .populate('cashierId', 'name')
    .populate('branchId', 'name code');
  if (!sale) throw ApiError.notFound('Sale not found');

  const [receipt, payments] = await Promise.all([
    Receipt.findOne({ saleId: sale._id }),
    Payment.find({ saleId: sale._id }),
  ]);
  return { sale, receipt, payments };
}

async function listSales(businessId, { branchId, cashierId, customerId, shiftId, from, to, paymentStatus, page, limit, search }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (cashierId) filter.cashierId = cashierId;
  if (customerId) filter.customerId = customerId;
  if (shiftId) filter.shiftId = shiftId;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  if (search) {
    filter.$or = [{ receiptNumber: new RegExp(search, 'i') }, { invoiceNumber: new RegExp(search, 'i') }];
  }

  const [items, total] = await Promise.all([
    Sale.find(filter)
      .populate('customerId', 'name phone')
      .populate('cashierId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Sale.countDocuments(filter),
  ]);

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * cancelSale - a full reversal of a just-rung, not-yet-settled sale (mis-ring,
 * customer walked away, etc). This is NOT a refund: it restores every unit
 * of inventory, reverses any customer credit, and marks associated
 * Payments as CANCELLED, all atomically. It is intentionally simple (whole
 * sale only) - partial corrections after the fact go through the Refund
 * flow instead, which tracks per-line refundedQuantity so it can never
 * exceed what was actually sold.
 */
async function cancelSale(businessId, userId, id, reason) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const sale = await Sale.findOne({ _id: id, businessId }).session(session);
      if (!sale) throw ApiError.notFound('Sale not found');
      if (sale.saleStatus !== 'COMPLETED') throw ApiError.conflict('Only a completed sale can be cancelled', 'INVALID_SALE_STATE');

      for (const item of sale.items) {
        const product = await Product.findOne({ _id: item.productId, businessId }).session(session);
        if (product?.trackInventory) {
          await applyStockChange({
            businessId, branchId: sale.branchId, productId: item.productId, variantId: item.variantId || null,
            quantityDelta: item.quantity, type: 'RETURN', referenceType: 'Sale', referenceId: sale._id,
            reason: `Sale ${sale.receiptNumber} cancelled`, performedBy: userId, session, allowNegative: true,
          });
        }
        if (item.serialNumbers?.length) {
          await SerialNumber.updateMany(
            { businessId, serialNumber: { $in: item.serialNumbers }, saleId: sale._id },
            { status: 'in_stock', $unset: { saleId: 1 } },
            { session }
          );
        }
        if (item.batchId) {
          await Batch.updateOne({ _id: item.batchId, businessId }, { $inc: { quantity: item.quantity } }, { session });
        }
      }

      if (sale.balance > 0 && sale.customerId) {
        const customer = await Customer.findOne({ _id: sale.customerId, businessId }).session(session);
        if (customer) {
          const newBalance = customer.outstandingBalance - sale.balance;
          await CustomerLedger.create(
            [{ businessId, customerId: customer._id, transactionType: 'REVERSAL', referenceType: 'Sale', referenceId: sale._id, debit: 0, credit: sale.balance, balance: newBalance, createdBy: userId, notes: 'Sale cancelled' }],
            { session }
          );
          await Customer.updateOne({ _id: customer._id }, { $inc: { outstandingBalance: -sale.balance } }, { session });
        }
      }

      await Payment.updateMany({ businessId, saleId: sale._id }, { status: 'CANCELLED' }, { session });

      sale.saleStatus = 'CANCELLED';
      sale.cancelledAt = new Date();
      sale.cancelledBy = userId;
      sale.cancelReason = reason;
      await sale.save({ session });

      await AuditLog.create(
        [{ businessId, branchId: sale.branchId, userId, action: 'sale.cancel', entityType: 'Sale', entityId: sale._id, newValue: { reason } }],
        { session }
      );

      result = sale;
    });
    return result;
  } finally {
    session.endSession();
  }
}

module.exports = { createSale, getSale, listSales, cancelSale };