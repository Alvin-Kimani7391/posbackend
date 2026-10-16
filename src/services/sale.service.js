const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Customer = require('../models/Customer');
const CustomerLedger = require('../models/CustomerLedger');
const Payment = require('../models/Payment');
const User = require('../models/User');

const mpesaService = require('./mpesa.service');
const etimsService = require('./etims.service');
const { assertCountry } = require('../middleware/requireCountry');
const { buildContext } = require('../utils/businessContext');
const notificationService = require('./notification.service');
const { CREDIT_WARNING_THRESHOLD } = require('../constants/notificationTypes');

const Receipt = require('../models/Receipt');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const CashShift = require('../models/CashShift');
const serialService = require('./serial.service');
const { normalizeSerial } = require('../utils/imei');
const batchService = require('./batch.service');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { applyStockChange, getStockLevel } = require('./inventory.service');
const { computeLineItem, computeSaleTotals, maxDiscountPercentForRole, canOverridePrice } = require('./sale-pricing.util');
const { PRICE_TYPES, resolveUnitPrice, sumQuantityByProduct } = require('../utils/wholesale');
const { resolveWarehouse, saleStockTarget } = require('./warehouse.resolver');
const { resolveUnit, wholesaleUnitPrice, retailUnitPrice, round3, wholesaleFloorPerBase } = require('../utils/units');

/** Escapes user text so it is matched literally inside a RegExp. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * createSale - see spec section 17 for the step list this follows exactly:
 * validate -> price on the backend only -> validate stock -> compute totals
 * -> (transaction) create sale -> decrement inventory -> record payments ->
 * update customer credit -> create receipt -> audit log.
 *
 * Money in `payload` arrives already converted to integer cents by the
 * validator layer (see validators/sale.validator.js) - this function never
 * does decimal/float math.
 *
 * RETAIL vs WHOLESALE: lines are priced by utils/wholesale.js#resolveUnitPrice. With the wholesalePricing feature on,
 * when the TOTAL quantity of a wholesale-enabled product in the sale reaches its MOQ, its lines are charged the
 * wholesale unit price (priceType WHOLESALE); otherwise retail. The client never sends the price; a permitted
 * overridePrice still wins and is recorded as OVERRIDE.
 *
 * PRODUCT DEFAULT DISCOUNT: a product may carry a standing per-unit discount
 * (Product.defaultDiscount, cents). The POS pre-fills the line discount with
 * (defaultDiscount x quantity), but the client is never trusted: the preset
 * portion of a line's discount is recomputed here from the Product record and
 * is exempt from the cashier's role discount limit (it is the owner's own
 * configured promotion). Only the part ABOVE the preset - what the cashier
 * added by hand - is checked against the role limit, exactly like before.
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

  // --- Sale mode: RETAIL sells the shop floor; WHOLESALE sells a WAREHOUSE's stock at wholesale prices ---
  const channel = payload.channel === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL';
  let warehouse = null;
  if (channel === 'WHOLESALE') {
    if (!business.featureSettings?.multiWarehouse) throw ApiError.forbidden('Wholesale selling needs the multiWarehouse feature', 'FEATURE_DISABLED');
    if (business.wholesaleSettings?.requireCustomerForWholesale && !customer) throw ApiError.badRequest('Choose a customer for a wholesale sale', 'CUSTOMER_REQUIRED');
    warehouse = await resolveWarehouse(businessId, { warehouseId: payload.warehouseId || business.wholesaleSettings?.defaultWarehouseId, branchId, userId: cashierUser._id, forSale: true });
  }
  const stockLocation = channel === 'WHOLESALE' ? 'WAREHOUSE' : 'RETAIL';
  const stockBranchId = warehouse ? warehouse.branchId : branchId;

  const taxInclusive = !!business.taxSettings?.taxInclusive;
  const maxDiscountPercent = maxDiscountPercentForRole(cashierUser.role, business);

  // --- Price and validate every line SERVER-SIDE. The frontend sends only
  // productId/variantId/quantity(/discount/overridePrice); unitPrice and
  // costPrice always come from the authoritative Product/ProductVariant
  // record fetched here, never from the request body. ---
  const wholesaleFeatureOn = business.featureSettings?.wholesalePricing === true;
  const qtyByProduct = sumQuantityByProduct(payload.items); // MOQ counted per product across the whole sale

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

    const unit = resolveUnit(product, rawItem.unitId);
    if (!unit.isBase && !business.featureSettings?.unitConversions) throw ApiError.forbidden('Unit conversion is not enabled for your business', 'FEATURE_DISABLED');
    if (product.trackSerialNumber && (!unit.isBase || channel === 'WHOLESALE')) {
      throw ApiError.badRequest(`${product.name} is serial-tracked: move it to retail and sell it there, one unit at a time`, 'SERIAL_RETAIL_ONLY');
    }
    const baseQuantity = round3(rawItem.quantity * unit.factor);

    let resolved;
    if (channel === 'WHOLESALE') resolved = { unitPrice: wholesaleUnitPrice(product, variant, unit), priceType: PRICE_TYPES.WHOLESALE };
    else if (!unit.isBase) resolved = { unitPrice: retailUnitPrice(product, variant, unit), priceType: PRICE_TYPES.RETAIL };
    else resolved = resolveUnitPrice({ product, variant, wholesaleFeatureOn, productQuantity: qtyByProduct.get(String(rawItem.productId)) });
    let unitPrice = resolved.unitPrice;
    let priceType = resolved.priceType;
    // cost is per SOLD unit, so profit = price - cost works for a bundle exactly as for a single piece
    const costPriceSnapshot = Math.round((variant ? variant.costPrice : product.costPrice) * unit.factor);
    const wsFloor = wholesaleFloorPerBase(product, variant);
    const wholesaleValueSnapshot = wsFloor ? Math.round(wsFloor * unit.factor) : undefined; // what one sold unit is worth at wholesale

    if (rawItem.overridePrice !== undefined && rawItem.overridePrice !== null) {
      if (!canOverridePrice(cashierUser, business)) {
        throw ApiError.forbidden('You are not allowed to override prices', 'PRICE_OVERRIDE_DENIED');
      }
      unitPrice = rawItem.overridePrice;
      priceType = PRICE_TYPES.OVERRIDE;
    }

    const discount = rawItem.discount || 0;
    const grossForLimit = Math.round(unitPrice * rawItem.quantity);

    // A line can never be discounted below zero.
    if (discount > grossForLimit) {
      throw ApiError.badRequest(`Discount on ${product.name} is more than the line total`, 'INVALID_DISCOUNT');
    }

    // Preset (owner-configured) part of the discount, recomputed from the
    // Product record - never taken from the client.
    const presetLineDiscount = Math.min(Math.round((product.defaultDiscount || 0) * unit.factor * rawItem.quantity), grossForLimit);

    // Whatever exceeds the preset was typed in by the cashier and is subject
    // to the role limit. The 1-cent tolerance absorbs rounding differences
    // between the POS preview and this calculation (e.g. fractional quantities).
    const manualDiscount = discount - presetLineDiscount;
    if (manualDiscount > 1 && maxDiscountPercent < 100) {
      const maxAllowed = Math.round((grossForLimit * maxDiscountPercent) / 100);
      if (manualDiscount > maxAllowed) {
        throw ApiError.forbidden(`Discount exceeds your limit of ${maxDiscountPercent}%`, 'DISCOUNT_LIMIT_EXCEEDED');
      }
    }

    const computed = computeLineItem({ unitPrice, quantity: rawItem.quantity, discount, taxRate: product.taxRate || 0, taxInclusive });

    if (product.trackSerialNumber) {
      if (!rawItem.serialNumbers || rawItem.serialNumbers.length !== rawItem.quantity) {
        throw ApiError.badRequest(`${product.name} requires exactly ${rawItem.quantity} serial number(s)`, 'SERIAL_COUNT_MISMATCH');
      }
      const normalized = rawItem.serialNumbers.map(normalizeSerial);
      if (new Set(normalized).size !== normalized.length) throw ApiError.badRequest(`${product.name}: the same serial number was entered twice`, 'DUPLICATE_SERIAL');
    }

    builtItems.push({
      productId: product._id,
      variantId: variant ? variant._id : undefined,
      nameSnapshot: product.name,
      skuSnapshot: variant ? variant.sku : product.sku,
      barcodeSnapshot: variant ? variant.barcode : product.barcode,
      quantity: rawItem.quantity,
      unitId: unit.id || undefined, unitName: unit.name, unitFactor: unit.factor, baseQuantity,
      unitPrice,
      priceType,
      costPriceSnapshot,
      wholesaleValueSnapshot,
      discount,
      taxRate: product.taxRate || 0,
      taxAmount: computed.taxAmount,
      total: computed.lineTotal,
      refundedQuantity: 0,
      batchId: rawItem.batchId || undefined,
      serialNumbers: (rawItem.serialNumbers || []).map(normalizeSerial),
      _meta: { product, variant, quantity: rawItem.quantity, baseQuantity, grossLineTotal: computed.grossLineTotal, discountApplied: discount },
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
      const level = await getStockLevel(businessId, stockBranchId, item.productId, item.variantId || null, stockLocation, warehouse?._id || null);
      if (level.availableQuantity < item._meta.baseQuantity) {
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
            // Invoice numbers have their OWN per-branch counter so online and offline sales share one
      // unique, gapless sequence per branch, and carry the branch code so branches can never collide at KRA.
      const invoiceSeq = await nextSequence(businessId, `invoice:branch:${branchId}`, session);
      const invoiceNumber = `${business.receiptSettings?.invoicePrefix || 'INV'}-${branch?.code || 'MAIN'}-${pad(invoiceSeq)}`;

      const [sale] = await Sale.create(
        [{
          businessId, branchId, receiptNumber, invoiceNumber,
          customerId: customer?._id, cashierId: cashierUser._id, shiftId: shift?._id,
          items: builtItems.map(({ _meta, ...rest }) => rest),
          subtotal: totals.subtotal, itemDiscount: totals.itemDiscount, cartDiscount, tax: totals.tax, total: totals.total,
          channel, warehouseId: warehouse?._id, dueDate: payload.dueDate || (channel === 'WHOLESALE' && balance > 0 && business.wholesaleSettings?.defaultPaymentTermsDays ? new Date(Date.now() + business.wholesaleSettings.defaultPaymentTermsDays * 86400000) : undefined),
          amountPaid: paidAmount, balance, paymentStatus, saleStatus: 'COMPLETED', source: 'POS',
          notes: payload.notes, clientTransactionId: payload.clientTransactionId, deviceId: payload.deviceId,
        }],
        { session }
      );

      // Resolve MPESA lines against verified MpesaTransactions before building
      // payment docs. CASH/CARD/BANK stay exactly as before (cashier-attested).
      for (const p of payments) {
        if (p.method === 'MOBILE_MONEY' && !p.reference) throw ApiError.badRequest('A mobile-money transaction reference is required', 'MOBILE_MONEY_REFERENCE_REQUIRED');
        if (p.method === 'MPESA') {
          // Automatic M-PESA verification (PayHero) is Kenya-only. Elsewhere use MOBILE_MONEY with a reference.
          await assertCountry(businessId, 'KE');
          if (!p.reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED');
          const confirmed = await mpesaService.consumeForSale(businessId, p.reference, p.amount, sale._id, session);
          p.provider = confirmed.channel === 'MANUAL' ? 'payhero-till' : 'payhero';
          p.externalTransactionId = confirmed.externalTransactionId;
          p.metadata = { checkoutRequestId: confirmed.checkoutRequestId, channel: confirmed.channel };
        }
      }

      // Inventory, serials, batches - one item at a time, same transaction.
      const allocByItem = new Map();
      for (const item of builtItems) {
        const { product, baseQuantity: quantity } = item._meta; // stock always moves in BASE units

        if (product.trackInventory) {
          await applyStockChange({
            businessId, branchId: stockBranchId, location: stockLocation, warehouseId: warehouse?._id || null, productId: item.productId, variantId: item.variantId || null,
            quantityDelta: -quantity, type: 'SALE', referenceType: 'Sale', referenceId: sale._id,
            reason: `Sale ${receiptNumber}`, performedBy: cashierUser._id, session,
            allowNegative: business.settings.allowNegativeStock,
          });
        }

        if (product.trackSerialNumber && item.serialNumbers?.length) {
          // Each serial must be in stock, at THIS branch and belong to THIS product; the shop warranty starts now.
          await serialService.markSold({
            businessId, branchId, product, serials: item.serialNumbers, saleId: sale._id,
            customerId: customer?._id, soldAt: new Date(), userId: cashierUser._id, session,
          });
        }

        // Batch-tracked products ALWAYS sell from a valid batch: the cashier's pick if given (must be in date,
        // sellable, same branch/product/variant), otherwise FEFO. Regulated businesses (quarantineManagement on:
        // pharmacy, cosmetics) can never sell un-batched stock; others may sell legacy stock that was never batched.
        if (product.trackBatch || item.batchId) {
          const strict = !!business.featureSettings?.quarantineManagement;
          const allocations = await batchService.allocateForSale({
            businessId, branchId: stockBranchId, location: stockLocation, productId: item.productId, variantId: item.variantId || null, quantity,
            requestedBatchId: item.batchId || null, allowUnbatchedRemainder: !strict,
            productName: item.nameSnapshot, session,
          });
          allocByItem.set(item, allocations);
        }
      }

      // Record which batch(es) each line came from (recall tracing, cancels, refunds).
      if (allocByItem.size) {
        const $set = {};
        builtItems.forEach((bi, i) => {
          const a = allocByItem.get(bi);
          if (a?.length) {
            $set[`items.${i}.batchAllocations`] = a;
            $set[`items.${i}.batchId`] = a[0].batchId;
            sale.items[i].batchAllocations = a;
            sale.items[i].batchId = a[0].batchId;
          }
        });
        if (Object.keys($set).length) await Sale.updateOne({ _id: sale._id }, { $set }, { session });
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

        // Detailed credit-sale notification - fires on EVERY credit/partial
        // sale (not only when a risk threshold is crossed), so both the
        // owner and the cashier who granted it always know it happened.
        notificationService.notifyCreditSaleIssued(businessId, branchId, customer, cashierUser, {
          amount: balance, saleId: sale._id, receiptNumber, newBalance, creditLimit: customer.creditLimit, paymentStatus,
        }).catch((err) => console.error('notifyCreditSaleIssued failed', err));

        // Credit-limit warning - fires only the moment the balance CROSSES
        // the warning threshold on this sale, not on every credit sale
        // after that (same crossing-check pattern as the low-stock hook in
        // inventory.service.js#applyStockChange, and the same in-transaction
        // trade-off: could theoretically fire for a sale that's later
        // rolled back). Also reaches the cashier, not just management,
        // since `actor` is passed through.
        const warningLine = Math.round(customer.creditLimit * CREDIT_WARNING_THRESHOLD);
        const wasBelowWarning = customer.outstandingBalance < warningLine;
        const nowAtOrAboveWarning = newBalance >= warningLine;
        if (customer.creditLimit > 0 && wasBelowWarning && nowAtOrAboveWarning) {
          notificationService.notifyCreditDue(businessId, customer, {
            outstandingBalance: newBalance, creditLimit: customer.creditLimit,
            trigger: 'sale', saleId: sale._id, receiptNumber, actor: cashierUser,
          }).catch((err) => console.error('notifyCreditDue failed', err));
        }
      }

      // Immutable receipt snapshot - a printer/PDF/SMS renderer needs only
      // this document. `business` here is a snapshot of receiptSettings AS
      // THEY WERE at sale time, so an owner changing them later never
      // rewrites a historical receipt.
      const [receipt] = await Receipt.create(
        [{
          businessId, branchId, saleId: sale._id, receiptNumber, invoiceNumber,
          receiptData: {
            // Currency / country / language of THIS business, frozen at sale time so a reprint always shows the same
            // currency and wording, and the tax-id label is right (KRA PIN in Kenya, TIN / VRN in Tanzania).
            locale: (() => { const c = buildContext(business); return { currency: c.currency, countryCode: c.countryCode, language: c.language, taxIdLabel: c.country.taxIdLabel[c.language] }; })(),
            business: {
              name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin || business.taxPin, vrn: business.vrn,
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
            items: builtItems.map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity, unitPrice: i.unitPrice, priceType: i.priceType, discount: i.discount, taxRate: i.taxRate, taxAmount: i.taxAmount, total: i.total })),
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

    // CRM: the sale is now COMMITTED. Ask the CRM to link it to a customer (by the picked
    // customer, or by the phone of the M-PESA payment). Fire-and-forget and fully guarded:
    // it can never delay, fail or roll back a sale. Sales with no customer and no M-PESA
    // phone are simply skipped inside the CRM. crmSync.job is the safety net.
    
    try {
      require('./crm.service').onSaleCompleted(businessId, result.sale._id);
    } catch (crmErr) {
      console.error('[crm] capture hook failed', crmErr.message);
    }

    // Start eTIMS processing only after the sale transaction commits.
    etimsService.kickForSale(businessId, result.sale._id);

    return result;

    } catch (err) {
    // Two syncs of the same sale can both pass the first findOne; the loser hits the unique index.
    if (err.code === 11000 && err.keyPattern?.clientTransactionId && payload.deviceId) {
      const existing = await Sale.findOne({
        businessId, branchId, deviceId: payload.deviceId, clientTransactionId: payload.clientTransactionId,
      });
      if (existing) return buildExistingSaleResult(existing);
    }
    throw err;
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
    filter.soldAt = {};
    if (from) filter.soldAt.$gte = new Date(from);
    if (to) filter.soldAt.$lte = new Date(to);
  }
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ receiptNumber: rx }, { invoiceNumber: rx }];
  }

  const [items, total] = await Promise.all([
    Sale.find(filter)
      .populate('customerId', 'name phone')
      .populate('cashierId', 'name')
      .populate('branchId', 'name code')
      .sort({ soldAt: -1 })
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
  let result;
  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findOne({ _id: id, businessId }).session(session);
      if (!sale) throw ApiError.notFound('Sale not found');
      if (sale.saleStatus !== 'COMPLETED') throw ApiError.conflict('Only a completed sale can be cancelled', 'INVALID_SALE_STATE');
      if (sale.source === 'GARAGE') throw ApiError.conflict('This is a garage invoice. Parts were used on the job, so it cannot be cancelled here. Refund the customer from the job card instead.', 'GARAGE_SALE');
      if (sale.source === 'REPAIR') throw ApiError.conflict('This is a repair invoice. Parts were used on the job, so it cannot be cancelled here. Refund the customer from the repair job instead.', 'REPAIR_SALE');

      const tgt = await saleStockTarget(businessId, sale, session);
      for (const item of sale.items) {
        const baseQty = item.baseQuantity || item.quantity;
        const product = await Product.findOne({ _id: item.productId, businessId }).session(session);
        if (product?.trackInventory) {
          await applyStockChange({
            businessId, branchId: tgt.branchId, location: tgt.location, warehouseId: tgt.warehouseId, productId: item.productId, variantId: item.variantId || null,
            quantityDelta: baseQty, type: 'RETURN', referenceType: 'Sale', referenceId: sale._id,
            reason: `Sale ${sale.receiptNumber} cancelled`, performedBy: userId, session, allowNegative: true,
          });
        }
        if (item.serialNumbers?.length) {
          // Only units still sold on this sale go back (a unit already returned/replaced is left alone).
          await serialService.releaseFromSale({ businessId, saleId: sale._id, serials: item.serialNumbers, userId, session });
        }
        if (item.batchId || item.batchAllocations?.length) {
          const notSellable = await batchService.restoreAllocations(businessId, item, session);
          // Units that went back into a held/expired batch must not count as sellable stock.
          if (notSellable > 0 && product?.trackInventory) {
            await applyStockChange({
              businessId, branchId: tgt.branchId, location: tgt.location, warehouseId: tgt.warehouseId, productId: item.productId, variantId: item.variantId || null,
              quantityDelta: -notSellable, type: 'ADJUSTMENT_OUT', referenceType: 'Sale', referenceId: sale._id,
              reason: `Sale ${sale.receiptNumber} cancelled: units returned to a held or expired batch`, performedBy: userId, session, allowNegative: true,
            });
          }
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

  // NOTE (unchanged from your original): everything below is unreachable
  // because of the `return result` inside the try block above, so
  // notifySaleCancelled never actually runs. Left as-is on purpose - fixing it
  // would start sending notifications, which is a separate change.
  const cashier = await User.findById(userId).select('name');
  notificationService.notifySaleCancelled(businessId, result.branchId, result, cashier)
    .catch((err) => console.error('notifySaleCancelled failed', err));

  return result;
}

module.exports = { createSale, getSale, listSales, cancelSale };