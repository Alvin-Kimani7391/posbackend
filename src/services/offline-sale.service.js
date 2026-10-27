'use strict';
/**
 * ingestOfflineSale - records what PHYSICALLY HAPPENED at an offline till.
 *
 * createSale (online) is strict: it rejects. This function never rejects over business rules,
 * because the goods already left the shop. It records the sale as the device saw it and FLAGS
 * anything odd (severity INFO / WARN / HIGH). Only a HIGH flag puts the sale in the manager's
 * "Needs review" queue.
 *
 * Hard rejections (IngestRejection -> quarantine, never discarded) are limited to things that make
 * a Sale impossible or untrustworthy: bad grant signature, unknown product, future-dated sale,
 * totals that do not add up, reused local sequence number.
 */
const mongoose = require('mongoose');
const pharmacyGuard = require('./pharmacy-guard.service');
const liquorGuard = require('./liquor/liquor-guard.service');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Customer = require('../models/Customer');
const CustomerLedger = require('../models/CustomerLedger');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Receipt = require('../models/Receipt');
const { isValidToken } = require('../utils/receiptToken');
const Branch = require('../models/Branch');
const CashShift = require('../models/CashShift');
const SerialNumber = require('../models/SerialNumber');
const Batch = require('../models/Batch');
const AuditLog = require('../models/AuditLog');
const Subscription = require('../models/Subscription');
const { nextSequence, pad } = require('../models/Counter');
const { ROLES } = require('../constants/roles');
const { verifyOfflineGrant } = require('../utils/offlineGrant');
const { getPolicy } = require('../utils/offlinePolicy');
const { applyStockChange } = require('./inventory.service');
const { computeLineItem, computeSaleTotals } = require('./sale-pricing.util');
const { PRICE_TYPES, resolveUnitPrice, sumQuantityByProduct } = require('../utils/wholesale');
const { resolveUnit, wholesaleUnitPrice, retailUnitPrice, wholesaleFloorPerBase, round3 } = require('../utils/units');
const { resolveWarehouse } = require('./warehouse.resolver');
const etimsService = require('./etims.service');
const offlineMpesa = require('./offline-mpesa.service');
const notificationService = require('./notification.service');
const { getBusinessContext } = require('../utils/businessContext');
const { formatMoney } = require('../utils/currency');
const { t: i18n } = require('../i18n');

const TIME_TOLERANCE_MS = 5 * 60 * 1000;
const flag = (code, severity, detail) => ({ code, severity, detail });

class IngestRejection extends Error {
  constructor(code, message, { releasable = true, status = 'REJECTED' } = {}) {
    super(message);
    this.code = code;
    this.releasable = releasable;
    this.status = status;
    this.isIngestRejection = true;
  }
}

/** Verifies the grant signature and that it really belongs to this business/device/branch. */
function verifyGrantForDevice(token, businessId, device) {
  let claims;
  try {
    claims = verifyOfflineGrant(token);
  } catch (err) {
    throw new IngestRejection('GRANT_INVALID', 'The offline grant signature is invalid', { releasable: false });
  }
  if (
    claims.businessId !== String(businessId) ||
    claims.deviceId !== device.deviceId ||
    claims.branchId !== String(device.branchId)
  ) {
    throw new IngestRejection('GRANT_MISMATCH', 'The offline grant does not belong to this device', { releasable: false });
  }
  return claims;
}

async function safeNotify(businessId, payload) {
  try {
    await notificationService.notifyManagement(businessId, payload);
  } catch (err) {
    console.error('[offline-sale] notify failed', err.message);
  }
}

/**
 * @param {object} ctx { business (doc), device (doc), claims, sale (validated payload), syncedAt, skewMs, force }
 * @returns {Promise<{status:'created'|'needs_review'|'duplicate', saleId, receiptNumber, invoiceNumber, flags}>}
 */
async function ingestOfflineSale(ctx) {
  const { business, device, claims, sale: s, syncedAt, skewMs = 0, force = false } = ctx;
  const businessId = business._id;
  const branchId = device.branchId;
  const caps = claims.caps || {};
  const policy = getPolicy(business);

  // ---- 1. already have it? (same device + same client id) ----
  const dup = await Sale.findOne({ businessId, branchId, deviceId: device.deviceId, clientTransactionId: s.clientTransactionId });
  if (dup) {
    return { status: 'duplicate', saleId: dup._id, receiptNumber: dup.receiptNumber, invoiceNumber: dup.invoiceNumber, reviewStatus: dup.reviewStatus };
  }

  // ---- 2. who / where ----
  const [branch, cashier] = await Promise.all([
    Branch.findOne({ _id: branchId, businessId }),
    User.findOne({ _id: claims.sub, businessId }),
  ]);
  if (!branch) throw new IngestRejection('BRANCH_NOT_FOUND', 'The device branch no longer exists', { releasable: false });
  if (!cashier) throw new IngestRejection('CASHIER_NOT_FOUND', 'The cashier account no longer exists', { releasable: false });

  const flags = [];
  const soldAt = s.soldAt;
  const soldAtMs = soldAt.getTime();

  // ---- 3. time & authority checks (flag, don't refuse) ----
  if (soldAtMs > syncedAt.getTime() + TIME_TOLERANCE_MS) {
    if (!force) throw new IngestRejection('FUTURE_DATED', 'The sale is dated in the future (device clock wrong?)');
    flags.push(flag('FUTURE_DATED', 'HIGH', `Sale dated ${soldAt.toISOString()} but synced ${syncedAt.toISOString()}`));
  }
  if (claims.issuedAtMs && soldAtMs < claims.issuedAtMs - TIME_TOLERANCE_MS) {
    flags.push(flag('SOLD_BEFORE_GRANT', 'HIGH', 'The sale time is earlier than the moment the offline grant was issued'));
  }
  if (claims.offlineUntil && soldAtMs > claims.offlineUntil + TIME_TOLERANCE_MS) {
    flags.push(flag('GRANT_EXPIRED', 'HIGH', 'The sale was made after the offline window ended'));
  }
  if (Math.abs(skewMs) > TIME_TOLERANCE_MS) {
    flags.push(flag('CLOCK_SKEW', Math.abs(skewMs) > 3600000 ? 'HIGH' : 'WARN', `Device clock was ${Math.round(skewMs / 60000)} min away from the server`));
  }
  if (device.status !== 'active') flags.push(flag('DEVICE_REVOKED_AT_SYNC', 'HIGH', 'The device was blocked before this sale was accepted'));
  if (cashier.status !== 'active') flags.push(flag('CASHIER_INACTIVE', 'HIGH', 'The cashier account is not active'));
  const branchWide = cashier.role === ROLES.OWNER || cashier.role === ROLES.ADMIN;
  if (!branchWide && !(cashier.branchIds || []).some((id) => String(id) === String(branchId))) {
    flags.push(flag('CASHIER_NOT_IN_BRANCH', 'WARN', 'The cashier is not assigned to this branch'));
  }
  if (claims.role && claims.role !== cashier.role) flags.push(flag('ROLE_CHANGED', 'INFO', `Role was ${claims.role} at sale time, now ${cashier.role}`));

  const sub = await Subscription.findOne({ businessId }).select('lock').lean();
  if (sub && sub.lock && sub.lock.active) {
    const lockedAtMs = sub.lock.at ? new Date(sub.lock.at).getTime() : null;
    flags.push(
      lockedAtMs && soldAtMs < lockedAtMs
        ? flag('ACCOUNT_LOCKED_AT_SYNC', 'INFO', 'The account was locked after this sale was made')
        : flag('SOLD_WHILE_LOCKED', 'HIGH', 'The sale was made while the account was locked')
    );
  }

  // ---- 3b. sale mode: RETAIL sells the shop floor, WHOLESALE sells a warehouse's stock (never rejected, only flagged) ----
  let channel = s.channel === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL';
  let warehouse = null;
  if (channel === 'WHOLESALE') {
    if (!(business.featureSettings && business.featureSettings.multiWarehouse)) flags.push(flag('WHOLESALE_NOT_ENABLED', 'HIGH', 'A wholesale sale was made but wholesale (multiWarehouse) is not enabled for this business'));
    try {
      warehouse = await resolveWarehouse(businessId, { warehouseId: s.warehouseId || (business.wholesaleSettings && business.wholesaleSettings.defaultWarehouseId) || undefined, branchId, userId: cashier._id });
      if (!warehouse.allowSales) flags.push(flag('WAREHOUSE_NO_SALES', 'WARN', `${warehouse.name} is storage only but a wholesale sale was made from it`));
    } catch (err) {
      flags.push(flag('WAREHOUSE_UNAVAILABLE', 'HIGH', `Wholesale sale: ${err.message}. Stock was taken from the shop floor instead`));
      channel = 'RETAIL'; // keeps stock, cancel and refund consistent: they follow where the stock really came from
    }
  }
  const stockLocation = warehouse ? 'WAREHOUSE' : 'RETAIL';
  const stockBranchId = warehouse ? warehouse.branchId : branchId;

  // ---- 4. lines: record the DEVICE's snapshot, recompute, compare ----
  const productIds = [...new Set(s.items.map((i) => i.productId))];
  const variantIds = [...new Set(s.items.filter((i) => i.variantId).map((i) => i.variantId))];
  const [products, variants] = await Promise.all([
    Product.find({ _id: { $in: productIds }, businessId }),
    variantIds.length ? ProductVariant.find({ _id: { $in: variantIds }, businessId }) : Promise.resolve([]),
  ]);
  const pMap = new Map(products.map((p) => [String(p._id), p]));
  const vMap = new Map(variants.map((v) => [String(v._id), v]));

  // Pharmacy: prescription / dispenser / restricted checks cannot run on an offline till, so such sales are escalated to review.
  try { (await pharmacyGuard.offlineFlags(business, products)).forEach((f) => flags.push(flag(f.code, f.level, f.message))); } catch (e) { console.error('[pharmacy] offline check failed', e.message); }

  // Wines & spirits: hours / dry day / licence / missing age check cannot be refused after the fact, so they are escalated to review.
  try { (await liquorGuard.offlineFlags(business, products, { soldAt: s.soldAt, hasAgeCheck: !!(s.ageCheck && s.ageCheck.confirmedOfAge) })).forEach((f) => flags.push(flag(f.code, f.level, f.message))); } catch (e) { console.error('[liquor] offline check failed', e.message); }

  const taxInclusive = !!(business.taxSettings && business.taxSettings.taxInclusive);
  const maxDiscountPercent = caps.maxDiscountPercent == null ? 0 : caps.maxDiscountPercent;
  // Wholesale: recompute which price SHOULD have applied (same rule as online) and compare with what the till charged.
  const wholesaleFeatureOn = !!(business.featureSettings && business.featureSettings.wholesalePricing === true);
  const qtyByProduct = sumQuantityByProduct(s.items);
  const built = [];
  const mismatches = [];

  s.items.forEach((it, idx) => {
    const product = pMap.get(it.productId);
    if (!product) throw new IngestRejection('PRODUCT_NOT_FOUND', `Line ${idx + 1}: the product no longer exists`, { releasable: false });
    const variant = it.variantId ? vMap.get(it.variantId) : null;
    if (it.variantId && !variant) throw new IngestRejection('VARIANT_NOT_FOUND', `Line ${idx + 1}: the variant no longer exists`, { releasable: false });

    if (product.status !== 'active' || (variant && variant.status !== 'active')) {
      flags.push(flag('PRODUCT_INACTIVE', 'WARN', `${product.name} was archived before this sale synced`));
    }

    const lastChange = Math.max(product.updatedAt ? product.updatedAt.getTime() : 0, variant && variant.updatedAt ? variant.updatedAt.getTime() : 0);
    // Unit conversion: the line may be in a bigger unit (3 bundles); stock always moves in BASE units.
    let unit;
    try {
      unit = resolveUnit(product, it.unitId);
    } catch (err) {
      if (!(it.unitFactor > 0)) throw new IngestRejection('UNIT_NOT_FOUND', `Line ${idx + 1}: the unit no longer exists on ${product.name}`, { releasable: false });
      unit = { id: it.unitId, name: it.unitName || 'unit', factor: it.unitFactor, isBase: false, unit: null };
      flags.push(flag('UNIT_NOT_FOUND', 'HIGH', `${product.name}: unit "${unit.name}" was removed; the till's factor ${unit.factor} was used`));
    }
    if (it.unitFactor > 0 && Math.abs(it.unitFactor - unit.factor) > 1e-9) flags.push(flag('UNIT_FACTOR_CHANGED', 'WARN', `${product.name}: till used ${it.unitFactor} per ${unit.name}, now ${unit.factor}`));
    const baseQuantity = round3(it.quantity * unit.factor);

    let resolved;
    if (channel === 'WHOLESALE') {
      const wp = wholesaleUnitPrice(product, variant, unit);
      resolved = { unitPrice: wp, priceType: PRICE_TYPES.WHOLESALE, retailPrice: retailUnitPrice(product, variant, unit), wholesalePrice: wp, moq: null };
    } else if (!unit.isBase) {
      const rp = retailUnitPrice(product, variant, unit);
      resolved = { unitPrice: rp, priceType: PRICE_TYPES.RETAIL, retailPrice: rp, wholesalePrice: null, moq: null };
    } else {
      resolved = resolveUnitPrice({ product, variant, wholesaleFeatureOn, productQuantity: qtyByProduct.get(it.productId) });
    }
    const currentPrice = resolved.unitPrice; // retail, or wholesale when the sale's quantity reaches the MOQ
    if (it.unitPriceCents !== currentPrice) {
      if (lastChange > soldAtMs) {
        flags.push(flag('PRICE_CHANGED_SINCE', 'INFO', `${product.name}: sold at ${it.unitPriceCents}c, catalog now ${currentPrice}c`));
      } else if (resolved.priceType === PRICE_TYPES.WHOLESALE && it.unitPriceCents === resolved.retailPrice) {
        // Charged retail although wholesale applied: no revenue lost, warning only.
        flags.push(flag('WHOLESALE_NOT_APPLIED', 'WARN', `${product.name}: quantity reached the MOQ (${resolved.moq}) so wholesale ${currentPrice}c applied, but the till charged retail ${it.unitPriceCents}c`));
      } else {
        flags.push(flag('PRICE_MISMATCH', 'HIGH', `${product.name}: device charged ${it.unitPriceCents}c but the catalog price was ${currentPrice}c`));
      }
    }
    // Tills cannot override prices: a line is WHOLESALE only when the till charged exactly the wholesale price.
    const priceType = channel === 'WHOLESALE' ? PRICE_TYPES.WHOLESALE
      : (resolved.wholesalePrice !== null && it.unitPriceCents === resolved.wholesalePrice && it.unitPriceCents !== resolved.retailPrice ? PRICE_TYPES.WHOLESALE : PRICE_TYPES.RETAIL);
    const catalogTax = product.taxRate || 0;
    if (it.taxRate !== catalogTax) {
      flags.push(
        lastChange > soldAtMs
          ? flag('TAX_RATE_CHANGED_SINCE', 'INFO', `${product.name}: sold at ${it.taxRate}% tax, catalog now ${catalogTax}%`)
          : flag('TAX_RATE_MISMATCH', 'HIGH', `${product.name}: device used ${it.taxRate}% tax but the catalog rate was ${catalogTax}%`)
      );
    }

    const computed = computeLineItem({ unitPrice: it.unitPriceCents, quantity: it.quantity, discount: it.discountCents, taxRate: it.taxRate, taxInclusive });
    if (it.discountCents > computed.grossLineTotal) {
      throw new IngestRejection('INVALID_DISCOUNT', `Line ${idx + 1}: discount is more than the line total`);
    }
    if (Math.abs(computed.lineTotal - it.totalCents) > 1) {
      mismatches.push(`Line ${idx + 1} (${product.name}): device total ${it.totalCents}c, recomputed ${computed.lineTotal}c`);
    }

    const preset = Math.min(Math.round((product.defaultDiscount || 0) * unit.factor * it.quantity), computed.grossLineTotal);
    const manual = it.discountCents - preset;
    if (manual > 1 && maxDiscountPercent < 100) {
      const maxAllowed = Math.round((computed.grossLineTotal * maxDiscountPercent) / 100);
      if (manual > maxAllowed) flags.push(flag('DISCOUNT_OVER_LIMIT', 'HIGH', `${product.name}: discount ${manual}c is above the ${maxDiscountPercent}% offline limit`));
    }

    built.push({
      productId: product._id,
      variantId: variant ? variant._id : undefined,
      nameSnapshot: it.name || product.name,
      skuSnapshot: variant ? variant.sku : product.sku,
      barcodeSnapshot: variant ? variant.barcode : product.barcode,
      quantity: it.quantity,
      unitId: unit.id || undefined, unitName: unit.name, unitFactor: unit.factor, baseQuantity,
      unitPrice: it.unitPriceCents,
      priceType,
      costPriceSnapshot: Math.round((variant ? variant.costPrice : product.costPrice) * unit.factor), // cost per SOLD unit at SYNC time (the device never holds cost)
      wholesaleValueSnapshot: (() => { const f = wholesaleFloorPerBase(product, variant); return f ? Math.round(f * unit.factor) : undefined; })(),
      discount: it.discountCents,
      taxRate: it.taxRate,
      taxAmount: computed.taxAmount,
      total: computed.lineTotal,
      refundedQuantity: 0,
      batchId: it.batchId || undefined,
      serialNumbers: it.serialNumbers || [],
      _meta: { product, variant, quantity: it.quantity, baseQuantity, gross: computed.grossLineTotal, discount: it.discountCents },
    });
  });

  const cartDiscount = s.cartDiscountCents || 0;
  const afterItemDiscount = built.reduce((a, i) => a + i._meta.gross - i._meta.discount, 0);
  if (cartDiscount > 0 && maxDiscountPercent < 100 && cartDiscount > Math.round((afterItemDiscount * maxDiscountPercent) / 100)) {
    flags.push(flag('CART_DISCOUNT_OVER_LIMIT', 'HIGH', `Cart discount ${cartDiscount}c is above the ${maxDiscountPercent}% offline limit`));
  }

  const totals = computeSaleTotals(
    built.map((i) => ({ grossLineTotal: i._meta.gross, taxAmount: i.taxAmount, lineTotal: i.total, discountApplied: i._meta.discount })),
    cartDiscount
  );
  if (totals.total < 0) throw new IngestRejection('INVALID_DISCOUNT', 'The discount is more than the sale total');
  if (Math.abs(totals.total - s.totalCents) > built.length + 1) {
    mismatches.push(`Sale total: device ${s.totalCents}c, recomputed ${totals.total}c`);
  }
  if (mismatches.length) {
    if (!force) throw new IngestRejection('TOTAL_MISMATCH', `Totals do not add up: ${mismatches.join('; ')}`);
    flags.push(flag('TOTAL_MISMATCH', 'HIGH', mismatches.join('; ')));
  }

  // ---- 5. payments, credit, methods ----
  const paidAmount = s.payments.reduce((a, p) => a + p.amountCents, 0);
  if (paidAmount > totals.total) flags.push(flag('OVERPAYMENT', 'HIGH', `Payments ${paidAmount}c are more than the total ${totals.total}c`));
  const balance = Math.max(totals.total - paidAmount, 0);
  const paymentStatus = balance === 0 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'CREDIT';

  let customer = null;
  if (s.customerId) {
    customer = await Customer.findOne({ _id: s.customerId, businessId });
    if (!customer) flags.push(flag('CUSTOMER_NOT_FOUND', 'WARN', 'The customer on the sale no longer exists'));
  }
  if (balance > 0) {
    if (!caps.allowCredit) flags.push(flag('CREDIT_NOT_ALLOWED', 'HIGH', `Credit of ${balance}c was given but offline credit was not allowed`));
    if (!customer) flags.push(flag('CREDIT_WITHOUT_CUSTOMER', 'HIGH', `${balance}c is owed but no customer is attached`));
    else if (customer.creditLimit > 0 && customer.outstandingBalance + balance > customer.creditLimit) {
      flags.push(flag('CREDIT_LIMIT_EXCEEDED', 'HIGH', `${customer.name} would owe ${customer.outstandingBalance + balance}c against a limit of ${customer.creditLimit}c`));
    }
  }
  if (s.payments.some((p) => p.method === 'CARD' || p.method === 'BANK' || p.method === 'MOBILE_MONEY') && !caps.allowCard) flags.push(flag('METHOD_NOT_ALLOWED', 'HIGH', 'A card or bank payment was recorded but these cannot be verified offline and are not allowed'));

  // ---- 6. shift ----
  let shift = null;
  if (s.shiftId || s.clientShiftId) {
    shift = s.shiftId
      ? await CashShift.findOne({ _id: s.shiftId, businessId, branchId })
      : await CashShift.findOne({ businessId, branchId, deviceId: device.deviceId, clientShiftId: s.clientShiftId });
    if (!shift) {
      flags.push(flag('SHIFT_NOT_FOUND', 'HIGH', 'The shift on the sale does not exist in this branch'));
    } else {
      if (String(shift.cashierId) !== String(cashier._id)) flags.push(flag('SHIFT_CASHIER_MISMATCH', 'HIGH', 'The shift belongs to a different cashier'));
      if (shift.status !== 'OPEN') flags.push(flag('SHIFT_CLOSED_AT_SYNC', 'HIGH', 'The shift was already closed when this sale synced; cash totals for that shift are now out by this sale'));
      const openedMs = shift.openedAt ? shift.openedAt.getTime() : 0;
      const closedMs = shift.closedAt ? shift.closedAt.getTime() : null;
      if (soldAtMs < openedMs - TIME_TOLERANCE_MS || (closedMs && soldAtMs > closedMs + TIME_TOLERANCE_MS)) {
        flags.push(flag('OUTSIDE_SHIFT_WINDOW', 'HIGH', 'The sale time is outside the shift open/close times'));
      }
    }
  } else if (s.payments.some((p) => p.method === 'CASH') && business.settings && business.settings.requireShift) {
    flags.push(flag('NO_SHIFT', 'HIGH', 'A cash sale has no shift attached'));
  }

  // ---- 7. numbers ----
  const receiptNumber = `${claims.receiptPrefix || (business.receiptSettings && business.receiptSettings.receiptPrefix) || 'RCT'}-${claims.branchCode || branch.code || 'MAIN'}-${claims.deviceCode || device.deviceCode}-${pad(s.localSeq)}`;
  const saleId = new mongoose.Types.ObjectId();

  // QR verification token. The till printed the receipt BEFORE it could reach us, so its QR already contains the till's
  // own random clientTransactionId: adopt exactly that as the verify token so the printed QR verifies once synced.
  const verifyToken = isValidToken(s.clientTransactionId) && !(await Receipt.exists({ verifyToken: s.clientTransactionId })) ? s.clientTransactionId : undefined;

  // ---- 8. write everything in ONE transaction ----
  const session = await mongoose.startSession();
  const post = { creditNote: null };
  let result;
  try {
    await session.withTransaction(async () => {
      const txFlags = []; // reset on every retry of the transaction callback
      post.creditNote = null;

      const invoiceSeq = await nextSequence(businessId, `invoice:branch:${branchId}`, session);
      const invoiceNumber = `${(business.receiptSettings && business.receiptSettings.invoicePrefix) || 'INV'}-${branch.code || 'MAIN'}-${pad(invoiceSeq)}`;

      // Stock, serials, batches. Negative stock is ACCEPTED (the goods are gone) and flagged.
      for (const item of built) {
        const { product, baseQuantity: quantity } = item._meta; // stock always moves in BASE units
        if (product.trackInventory) {
          const r = await applyStockChange({
            businessId, branchId: stockBranchId, location: stockLocation, warehouseId: warehouse ? warehouse._id : null, productId: item.productId, variantId: item.variantId || null,
            quantityDelta: -quantity, type: 'SALE', referenceType: 'Sale', referenceId: saleId,
            reason: `Offline sale ${receiptNumber}`, performedBy: cashier._id, session, allowNegative: true,
            occurredAt: soldAt,
          });
          if (r.branchInventory.quantity < 0) txFlags.push(flag('NEGATIVE_STOCK', 'WARN', `${item.nameSnapshot} is now at ${r.branchInventory.quantity}`));
        }
        if (product.trackSerialNumber && item.serialNumbers && item.serialNumbers.length) {
          for (const sn of item.serialNumbers) {
            const updated = await SerialNumber.findOneAndUpdate(
              { businessId, serialNumber: sn, status: 'in_stock' },
              { status: 'sold', saleId },
              { session, new: true }
            );
            if (!updated) txFlags.push(flag('SERIAL_UNAVAILABLE', 'HIGH', `Serial number ${sn} was not in stock`));
          }
        }
        if (item.batchId) {
          const b = await Batch.findOneAndUpdate({ _id: item.batchId, businessId }, { $inc: { quantity: -quantity } }, { session, new: true });
          if (!b) txFlags.push(flag('BATCH_NOT_FOUND', 'WARN', `Batch for ${item.nameSnapshot} was not found`));
          else if (b.quantity < 0) txFlags.push(flag('BATCH_SHORT', 'WARN', `Batch for ${item.nameSnapshot} is now negative`));
          // The goods are gone, so the sale is accepted, but a sale from an expired / held batch must be reviewed.
          if (b && (b.status === 'quarantined' || b.status === 'recalled')) txFlags.push(flag('BATCH_HELD', 'HIGH', `${item.nameSnapshot}: batch ${b.batchNumber} is ${b.status}`));
          else if (b && b.expiryDate && new Date(b.expiryDate) < new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()))) txFlags.push(flag('BATCH_EXPIRED', 'HIGH', `${item.nameSnapshot}: batch ${b.batchNumber} had expired`));
        }
      }

      // Payments (M-PESA goes through the till-code claim flow).
      const paymentDocs = [];
      const claimResults = [];
      for (const p of s.payments) {
        const paymentId = new mongoose.Types.ObjectId();
        const doc = {
          _id: paymentId, businessId, branchId, saleId, customerId: customer ? customer._id : undefined, shiftId: shift ? shift._id : undefined,
          method: p.method, provider: 'manual', amount: p.amountCents, reference: p.reference,
          initiatedBy: cashier._id, status: 'SUCCESS', completedAt: soldAt, createdAt: soldAt, // payment reports use createdAt: keep them on the real sale date
        };
        if (p.method === 'CASH') {
          doc.amountTendered = p.amountTenderedCents == null ? p.amountCents : p.amountTenderedCents;
          doc.changeGiven = Math.max(0, doc.amountTendered - p.amountCents);
        }
        if (p.method === 'MPESA') {
          const r = await offlineMpesa.recordClaimInTx({
            businessId, branchId, saleId, paymentId, cashierId: cashier._id, deviceId: device.deviceId, deviceCode: device.deviceCode,
            soldAt, amountCents: p.amountCents, mpesa: p.mpesa,
            approvalMode: claims.limits && claims.limits.manualMpesaApproval ? claims.limits.manualMpesaApproval : policy.manualMpesaApproval,
            maxManualMpesaCents: claims.limits && claims.limits.maxManualMpesaCents != null ? claims.limits.maxManualMpesaCents : policy.maxManualMpesaCents,
            notAllowed: !caps.allowManualMpesa, session,
          });
          claimResults.push(r);
          txFlags.push(...r.flags);
          doc.provider = 'payhero-till';
          doc.reference = p.mpesa.code;
          doc.status = r.payment.status;
          doc.completedAt = r.payment.completedAt;
          doc.externalTransactionId = r.payment.externalTransactionId;
          doc.metadata = r.payment.metadata;
        }
        paymentDocs.push(doc);
      }
      if (paymentDocs.length) await Payment.create(paymentDocs, { session });

      // Customer credit ledger (never edit the balance directly).
      if (balance > 0 && customer) {
        const newBalance = customer.outstandingBalance + balance;
        await CustomerLedger.create(
          [{ businessId, customerId: customer._id, transactionType: 'SALE_CREDIT', referenceType: 'Sale', referenceId: saleId, debit: balance, credit: 0, balance: newBalance, createdBy: cashier._id }],
          { session }
        );
        await Customer.updateOne({ _id: customer._id }, { $inc: { outstandingBalance: balance } }, { session });
        post.creditNote = { amount: balance, newBalance, creditLimit: customer.creditLimit };
      }

      // Receipt snapshot.
      const bs = business.receiptSettings || {};
      await Receipt.create(
        [{
          businessId, branchId, saleId, receiptNumber, invoiceNumber, soldAt, isOffline: true, verifyToken,
          receiptData: {
            business: {
              name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin,
              footerMessage: bs.footerMessage, headerMessage: bs.headerMessage,
              logo: bs.showLogo ? business.logo : undefined,
              showKraPin: bs.showKraPin == null ? true : bs.showKraPin,
              showCashierName: bs.showCashierName == null ? true : bs.showCashierName,
              showMpesaReceiptCode: bs.showMpesaReceiptCode == null ? true : bs.showMpesaReceiptCode,
              customLines: bs.customLines || [], paperWidth: bs.paperWidth || '80mm',
            },
            branch: { name: branch.name, phone: branch.phone },
            cashier: { name: cashier.name },
            customer: customer ? { name: customer.name, phone: customer.phone } : null,
            items: built.map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity, unitPrice: i.unitPrice, priceType: i.priceType, discount: i.discount, taxRate: i.taxRate, taxAmount: i.taxAmount, total: i.total })),
            subtotal: totals.subtotal, itemDiscount: totals.itemDiscount, cartDiscount, tax: totals.tax, total: totals.total,
            payments: paymentDocs.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference, externalTransactionId: p.method === 'MPESA' ? p.reference : p.externalTransactionId })),
            amountTendered: paymentDocs.filter((p) => p.method === 'CASH').reduce((a, p) => a + (p.amountTendered || 0), 0),
            changeGiven: paymentDocs.filter((p) => p.method === 'CASH').reduce((a, p) => a + (p.changeGiven || 0), 0),
            balance, paymentStatus,
          },
        }],
        { session }
      );

      const allFlags = [...flags, ...txFlags];
      const reviewStatus = allFlags.some((f) => f.severity === 'HIGH') ? 'PENDING' : 'NONE';

      const [sale] = await Sale.create(
        [{
          _id: saleId, businessId, branchId, receiptNumber, invoiceNumber,
          customerId: customer ? customer._id : undefined, cashierId: cashier._id, shiftId: shift ? shift._id : undefined,
          items: built.map(({ _meta, ...rest }) => rest),
          subtotal: totals.subtotal, itemDiscount: totals.itemDiscount, cartDiscount, tax: totals.tax, total: totals.total,
          amountPaid: paidAmount, balance, paymentStatus, saleStatus: 'COMPLETED', source: 'SYNC', notes: s.notes,
          channel, warehouseId: warehouse ? warehouse._id : undefined,
          dueDate: s.dueDate || (channel === 'WHOLESALE' && balance > 0 && business.wholesaleSettings && business.wholesaleSettings.defaultPaymentTermsDays ? new Date(soldAt.getTime() + business.wholesaleSettings.defaultPaymentTermsDays * 86400000) : undefined),
          clientTransactionId: s.clientTransactionId, deviceId: device.deviceId,
          soldAt, syncedAt, isOffline: true, localSeq: s.localSeq, catalogVersion: s.catalogVersion, clockSkewMs: skewMs, grantId: claims.jti,
          reviewStatus, reviewFlags: allFlags,
        }],
        { session }
      );

      await AuditLog.create(
        [{
          businessId, branchId, userId: cashier._id, action: 'sale.create.offline', entityType: 'Sale', entityId: saleId,
          newValue: { receiptNumber, total: totals.total, paymentStatus, deviceCode: device.deviceCode, localSeq: s.localSeq, soldAt, flags: allFlags.map((f) => f.code) },
        }],
        { session }
      );

      await etimsService.enqueueForSale(businessId, branchId, saleId, { session });

      result = { status: reviewStatus === 'PENDING' ? 'needs_review' : 'created', saleId: sale._id, receiptNumber, invoiceNumber, reviewStatus, flags: allFlags, sale };
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const kp = err.keyPattern || {};
      if (kp.clientTransactionId || kp.verifyToken) {
        const existing = await Sale.findOne({ businessId, branchId, deviceId: device.deviceId, clientTransactionId: s.clientTransactionId });
        if (existing) return { status: 'duplicate', saleId: existing._id, receiptNumber: existing.receiptNumber, invoiceNumber: existing.invoiceNumber, reviewStatus: existing.reviewStatus };
      }
      if (kp.localSeq) throw new IngestRejection('LOCALSEQ_REUSED', `Local receipt sequence ${s.localSeq} was already used by this device for a different sale`, { releasable: false });
      if (kp.receiptNumber) throw new IngestRejection('RECEIPT_NUMBER_COLLISION', `Receipt number ${receiptNumber} already exists`, { releasable: false });
    }
    throw err;
  } finally {
    session.endSession();
  }

  // ---- 9. AFTER commit: side effects that must never roll back or block a sale ----
  etimsService.kickForSale(businessId, result.saleId);
  try {
    Promise.resolve(require('./crm.service').onSaleCompleted(businessId, result.saleId)).catch((e) => console.error('[crm] capture hook failed', e.message));
  } catch (e) {
    console.error('[crm] capture hook failed', e.message);
  }
  if (post.creditNote && customer) {
    notificationService.notifyCreditSaleIssued(businessId, branchId, customer, cashier, {
      amount: post.creditNote.amount, saleId: result.saleId, receiptNumber, newBalance: post.creditNote.newBalance,
      creditLimit: post.creditNote.creditLimit, paymentStatus,
    }).catch((e) => console.error('notifyCreditSaleIssued failed', e.message));
  }
  if (result.reviewStatus === 'PENDING') {
    const bctx = await getBusinessContext(businessId);
    const high = result.flags.filter((f) => f.severity === 'HIGH').map((f) => f.code);
    await safeNotify(businessId, {
      type: 'OFFLINE_REVIEW',
      title: 'Offline sale needs review',
      message: `${i18n(bctx.language, 'offline.syncedSale', { receipt: receiptNumber, amount: formatMoney(totals.total, bctx.currency, { lang: bctx.language }), device: device.deviceCode || 'a till' })} - ${[...new Set(high)].join(', ')}.`,
      data: { saleId: result.saleId, flags: [...new Set(high)] },
    });
  }

  const { sale: _omit, ...out } = result;
  return out;
}

module.exports = { ingestOfflineSale, verifyGrantForDevice, IngestRejection };