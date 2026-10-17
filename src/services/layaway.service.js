/**
 * Layaway (lay-by): the customer reserves stock at today's price and pays in instalments; the goods are handed over
 * once fully paid.
 *
 * Money model (same as repairs / garage): deposits and instalments are real Payment records (payments report, cash shift,
 * drawer count). They are cash received but NOT revenue. Revenue is recognised when the customer collects, when a normal
 * Sale (source LAYAWAY) is created, so tax, cost, eTIMS and CRM follow the usual path. If the customer cancels, the shop
 * keeps a fee (a % of what was paid, set by the business) which is invoiced as income; the rest is refunded.
 *
 * Stock model: reserved units stay in BranchInventory.quantity (they are physically in the shop, so a stocktake still
 * counts them) but are removed from availableQuantity, so nothing else can sell or move them. Serial-tracked units are
 * held individually (status "reserved"). At collection the reservation is consumed and a SALE movement is logged.
 */
const mongoose = require('mongoose');
const Layaway = require('../models/Layaway');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Customer = require('../models/Customer');
const Business = require('../models/Business');
const Payment = require('../models/Payment');
const Sale = require('../models/Sale');
const CashShift = require('../models/CashShift');
const AuditLog = require('../models/AuditLog');
const mpesaService = require('./mpesa.service');
const etimsService = require('./etims.service');
const serialService = require('./serial.service');
const { applyStockChange, reserveStock, releaseReserved } = require('./inventory.service');
const { createInvoiceSale } = require('./invoice-sale.helper');
const { computeLineItem, computeSaleTotals } = require('./sale-pricing.util');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { normalizePhone } = require('../utils/phone');
const { normalizeSerial } = require('../utils/imei');
const { hasPermission } = require('../utils/permissionCheck');
const { assertCountry } = require('../middleware/requireCountry');

const DAY = 86400000;
const FEE_SKU = 'LAYAWAY-FEE';

async function inTx(fn) {
  const session = await mongoose.startSession();
  try { let out; await session.withTransaction(async () => { out = await fn(session); }); return out; } finally { session.endSession(); }
}

const termsFor = (business) => ({
  minDepositPercent: business?.layawaySettings?.minDepositPercent ?? 20,
  maxDays: business?.layawaySettings?.maxDays ?? 60,
  cancellationFeePercent: business?.layawaySettings?.cancellationFeePercent ?? 10,
  graceDays: business?.layawaySettings?.graceDays ?? 7,
});

const minDeposit = (total, pct) => Math.ceil((total * pct) / 100);
/** Fee kept when the CUSTOMER cancels: a % of what they paid (never more than they paid). */
const feeFor = (paid, pct) => Math.min(paid, Math.round((paid * pct) / 100));

function recalc(l) {
  l.paid = l.payments.reduce((s, p) => s + (p.type === 'REFUND' ? -p.amount : p.amount), 0);
  l.balance = l.total - l.paid;
}
const log = (l, event, by, note) => l.history.push({ at: new Date(), event, by, note });
const load = async (businessId, id, session) => {
  const q = Layaway.findOne({ _id: id, businessId });
  const l = await (session ? q.session(session) : q);
  if (!l) throw ApiError.notFound('Layaway not found');
  return l;
};
const endOfDay = (d) => { const x = new Date(d); x.setUTCHours(20, 59, 59, 999); return x; }; // 23:59:59 Nairobi (UTC+3)

/** Take one payment (or deposit) against a layaway document. Mutates `l`; caller saves. Same rules as a till / repair. */
async function takePayment({ businessId, user, l, type, method, amount, reference, provider: railLabel, session }) {
  const business = await Business.findById(businessId).select('settings').session(session);
  const shift = await CashShift.findOne({ businessId, branchId: l.branchId, cashierId: user._id, status: 'OPEN' }).session(session);
  if (method === 'CASH' && business?.settings?.requireShift && !shift) throw ApiError.badRequest('Open a cash shift before taking cash payments', 'SHIFT_REQUIRED');

  let provider = 'manual'; let externalTransactionId; let verified = false; let metadata;
  if (method === 'MPESA') await assertCountry(businessId, 'KE'); // verified M-PESA (PayHero) is Kenya-only; elsewhere use MOBILE_MONEY
  if (method === 'MOBILE_MONEY') {
    if (!reference) throw ApiError.badRequest('A mobile-money transaction reference is required', 'MOBILE_MONEY_REFERENCE_REQUIRED');
    provider = railLabel || 'manual'; // which rail: M-Pesa, Mixx by Yas, Airtel Money, HaloPesa...
  }
  if (method === 'MPESA' && type !== 'REFUND') {
    if (!reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED');
    const confirmed = await mpesaService.consumeForLayaway(businessId, reference, amount, l._id, session);
    provider = confirmed.channel === 'MANUAL' ? 'payhero-till' : 'payhero';
    externalTransactionId = confirmed.externalTransactionId; verified = true;
    metadata = { checkoutRequestId: confirmed.checkoutRequestId, channel: confirmed.channel };
  }
  if (method === 'MOBILE_MONEY' && type === 'REFUND' && !reference) throw ApiError.badRequest('Enter the transaction reference of the refund you sent', 'MOBILE_MONEY_REFERENCE_REQUIRED');
  if (method === 'MPESA' && type === 'REFUND' && !reference) throw ApiError.badRequest('Enter the M-PESA reference of the refund you sent', 'MPESA_REFERENCE_REQUIRED');

  const [payment] = await Payment.create([{
    businessId, branchId: l.branchId, layawayId: l._id, customerId: l.customerId, shiftId: shift?._id,
    method, provider, amount, reference, externalTransactionId, metadata,
    initiatedBy: user._id, status: type === 'REFUND' ? 'REFUNDED' : 'SUCCESS', completedAt: new Date(),
    ...(method === 'CASH' && type !== 'REFUND' ? { amountTendered: amount, changeGiven: 0 } : {}),
  }], { session });
  l.payments.push({ type, method, amount, reference, provider: method === 'MOBILE_MONEY' ? provider : undefined, by: user._id, verified, paymentId: payment._id });
  recalc(l);
  return payment;
}

/**
 * Open a layaway. Reserves the stock/serials, locks prices, and takes the first payment, which must be at least the
 * business's minimum deposit. Nothing is reserved without a deposit.
 */
async function create(businessId, branchId, user, input) {
  return inTx(async (session) => {
    const business = await Business.findById(businessId).session(session);
    if (!business) throw ApiError.notFound('Business not found');
    const terms = termsFor(business);

    const customer = await Customer.findOne({ _id: input.customerId, businessId, status: 'active' }).session(session);
    if (!customer) throw ApiError.badRequest('A registered customer is required for a layaway', 'CUSTOMER_REQUIRED');
    if (!normalizePhone(customer.phone)) throw ApiError.badRequest('The customer needs a valid phone number so we can remind them about payments', 'CUSTOMER_PHONE_REQUIRED');

    const now = Date.now();
    const due = new Date(input.dueDate);
    if (due.getTime() <= now) throw ApiError.badRequest('The due date must be in the future', 'BAD_DUE_DATE');
    if (due.getTime() > now + terms.maxDays * DAY + DAY) throw ApiError.badRequest(`A layaway can run for at most ${terms.maxDays} days`, 'DUE_DATE_TOO_FAR');

    const _id = new mongoose.Types.ObjectId();
    const taxInclusive = business.taxSettings?.taxInclusive !== false;
    const items = []; const lines = [];
    for (const raw of input.items) {
      const product = await Product.findOne({ _id: raw.productId, businessId, status: 'active' }).session(session);
      if (!product) throw ApiError.badRequest(`Product not found: ${raw.productId}`, 'PRODUCT_NOT_FOUND');
      if (!product.trackInventory) throw ApiError.badRequest(`${product.name} is not a stocked item and cannot be put on layaway`, 'LAYAWAY_UNSUPPORTED');
      if (product.trackBatch || product.trackExpiry) throw ApiError.badRequest(`${product.name} is batch/expiry tracked and cannot be held on layaway`, 'LAYAWAY_UNSUPPORTED');
      let variant = null;
      if (raw.variantId) {
        variant = await ProductVariant.findOne({ _id: raw.variantId, businessId, productId: product._id, status: 'active' }).session(session);
        if (!variant) throw ApiError.badRequest('Variant not found', 'VARIANT_NOT_FOUND');
      } else if (product.hasVariants) throw ApiError.badRequest(`${product.name} requires a variant to be selected`, 'VARIANT_REQUIRED');

      const unitPrice = variant ? variant.sellingPrice : product.sellingPrice;
      const gross = Math.round(unitPrice * raw.quantity);
      const discount = Math.min(Math.round((product.defaultDiscount || 0) * raw.quantity), gross); // the owner's standing promotion, as at the till
      const c = computeLineItem({ unitPrice, quantity: raw.quantity, discount, taxRate: product.taxRate || 0, taxInclusive });

      let serialNumbers = [];
      if (product.trackSerialNumber) {
        if (!Number.isInteger(raw.quantity)) throw ApiError.badRequest(`${product.name}: quantity must be a whole number`, 'BAD_QUANTITY');
        serialNumbers = serialService.cleanSerials(product, (raw.serialNumbers || []).map(normalizeSerial));
        if (serialNumbers.length !== raw.quantity) throw ApiError.badRequest(`${product.name} requires exactly ${raw.quantity} serial number(s)`, 'SERIAL_COUNT_MISMATCH');
        await serialService.reserveForLayaway({ businessId, branchId, product, serials: serialNumbers, layawayId: _id, userId: user._id, session });
      }
      await reserveStock({ businessId, branchId, productId: product._id, variantId: variant ? variant._id : null, quantity: raw.quantity, session });

      items.push({
        productId: product._id, variantId: variant ? variant._id : null, nameSnapshot: product.name, skuSnapshot: variant ? variant.sku : product.sku,
        barcodeSnapshot: variant ? variant.barcode : product.barcode, quantity: raw.quantity, unitPrice, costPriceSnapshot: variant ? variant.costPrice : product.costPrice,
        discount, taxRate: product.taxRate || 0, taxAmount: c.taxAmount, total: c.lineTotal, stockReserved: true, serialNumbers,
      });
      lines.push({ grossLineTotal: c.grossLineTotal, taxAmount: c.taxAmount, lineTotal: c.lineTotal, discountApplied: discount });
    }
    const totals = computeSaleTotals(lines, 0);
    if (totals.total <= 0) throw ApiError.badRequest('The layaway total must be more than zero', 'EMPTY_LAYAWAY');

    const needed = minDeposit(totals.total, terms.minDepositPercent);
    if (input.deposit.amount < needed) throw ApiError.badRequest(`The first payment must be at least ${terms.minDepositPercent}% of the total`, 'DEPOSIT_TOO_LOW', [{ minimum: needed }]);
    if (input.deposit.amount > totals.total) throw ApiError.badRequest('The payment is more than the total', 'OVERPAYMENT');

    const seq = await nextSequence(businessId, 'layaway:business', session);
    const l = new Layaway({
      _id, businessId, branchId, number: `LAY-${pad(seq)}`, customerId: customer._id, customerName: customer.name, customerPhone: customer.phone,
      items, subtotal: totals.subtotal, itemDiscount: totals.itemDiscount, tax: totals.tax, total: totals.total, taxInclusive, terms,
      dueDate: endOfDay(due), originalDueDate: endOfDay(due), notes: input.notes, createdBy: user._id,
      history: [{ at: new Date(), event: 'OPENED', by: user._id, note: `Total ${totals.total} cents, due ${due.toISOString().slice(0, 10)}` }],
    });
    recalc(l);
    await takePayment({ businessId, user, l, type: 'DEPOSIT', ...input.deposit, session });
    await l.save({ session });
    await AuditLog.create([{ businessId, branchId, userId: user._id, action: 'layaway.create', entityType: 'Layaway', entityId: l._id, newValue: { number: l.number, total: l.total, deposit: input.deposit.amount } }], { session });
    return l;
  });
}

/** An instalment. Cannot exceed the balance; the goods are handed over separately with collect(). */
async function recordPayment(businessId, user, id, { method, amount, reference, provider }) {
  return inTx(async (session) => {
    const l = await load(businessId, id, session);
    if (l.status !== 'ACTIVE') throw ApiError.conflict(`This layaway is ${l.status}`, 'INVALID_LAYAWAY_STATE');
    if (amount > l.balance) throw ApiError.badRequest('Payment is more than the balance owing', 'OVERPAYMENT');
    await takePayment({ businessId, user, l, type: 'INSTALMENT', method, amount, reference, provider, session });
    if (l.balance === 0) log(l, 'FULLY_PAID', user._id);
    await l.save({ session });
    await AuditLog.create([{ businessId, branchId: l.branchId, userId: user._id, action: 'layaway.payment', entityType: 'Layaway', entityId: l._id, newValue: { method, amount, reference, balance: l.balance } }], { session });
    return l;
  });
}

/** Manager extends the due date (reason required). Never beyond twice the normal maximum from the day it was opened. */
async function extend(businessId, user, id, { newDueDate, reason }) {
  const l = await load(businessId, id);
  if (l.status !== 'ACTIVE') throw ApiError.conflict(`This layaway is ${l.status}`, 'INVALID_LAYAWAY_STATE');
  const to = endOfDay(newDueDate);
  if (to <= l.dueDate) throw ApiError.badRequest('The new due date must be after the current one', 'BAD_DUE_DATE');
  const limit = l.createdAt.getTime() + 2 * (l.terms?.maxDays || 60) * DAY;
  if (to.getTime() > limit) throw ApiError.badRequest('That is beyond the longest extension allowed', 'EXTENSION_TOO_LONG');
  l.extensions.push({ at: new Date(), by: user._id, from: l.dueDate, to, reason });
  l.dueDate = to; log(l, 'EXTENDED', user._id, reason);
  await l.save();
  await AuditLog.create({ businessId, branchId: l.branchId, userId: user._id, action: 'layaway.extend', entityType: 'Layaway', entityId: l._id, newValue: { to, reason } });
  return l;
}

/**
 * Hand over the goods. Only when fully paid. Consumes the reservations, sells the serials, and invoices the layaway as a
 * normal Sale (this is when it becomes revenue).
 */
async function collect(businessId, user, id, { collectedByName, idChecked = false }) {
  const out = await inTx(async (session) => {
    const l = await load(businessId, id, session);
    if (l.status !== 'ACTIVE') throw ApiError.conflict(`This layaway is ${l.status}`, 'INVALID_LAYAWAY_STATE');
    recalc(l);
    if (l.balance > 0) throw ApiError.conflict(`Balance of ${l.balance} cents is still owing`, 'BALANCE_OWING');
    if (l.paid !== l.total) throw ApiError.conflict('Payments and total do not add up. Please contact support.', 'LAYAWAY_TOTALS_MISMATCH');

    const business = await Business.findById(businessId).session(session);
    const customer = await Customer.findOne({ _id: l.customerId, businessId }).session(session);
    const saleItems = []; const productOf = new Map();
    for (const it of l.items) {
      const product = await Product.findOne({ _id: it.productId, businessId }).session(session);
      productOf.set(String(it._id), product);
      if (it.stockReserved) {
        await applyStockChange({
          businessId, branchId: l.branchId, productId: it.productId, variantId: it.variantId || null, quantityDelta: -it.quantity, type: 'SALE',
          referenceType: 'Layaway', referenceId: l._id, reason: `Layaway ${l.number} collected`, performedBy: user._id, session, fromReserved: true,
        });
      }
      saleItems.push({
        productId: it.productId, variantId: it.variantId || undefined, nameSnapshot: it.nameSnapshot, skuSnapshot: it.skuSnapshot, barcodeSnapshot: it.barcodeSnapshot,
        quantity: it.quantity, unitPrice: it.unitPrice, costPriceSnapshot: it.costPriceSnapshot, discount: it.discount, taxRate: it.taxRate, taxAmount: it.taxAmount, total: it.total,
        refundedQuantity: 0, serialNumbers: it.serialNumbers || [],
      });
    }

    const totals = { subtotal: l.subtotal, itemDiscount: l.itemDiscount, tax: l.tax, total: l.total };
    const sale = await createInvoiceSale({
      business, branchId: l.branchId, user, session, customer, items: saleItems, totals, paid: l.paid, source: 'LAYAWAY', links: { layawayId: l._id },
      payments: l.payments.filter((p) => p.type !== 'REFUND').map((p) => ({ method: p.method, provider: p.provider, amount: p.amount, reference: p.reference })),
      notes: `Layaway ${l.number}`, extraReceiptLines: [`Layaway ${l.number} - collected in full`],
    });

    for (const it of l.items) {
      if (it.serialNumbers?.length) {
        await serialService.markSoldFromLayaway({ businessId, branchId: l.branchId, product: productOf.get(String(it._id)), serials: it.serialNumbers, layawayId: l._id, saleId: sale._id, customerId: l.customerId, userId: user._id, session });
      }
    }
    await Payment.updateMany({ businessId, layawayId: l._id }, { $set: { saleId: sale._id } }, { session });

    l.status = 'COMPLETED'; l.saleId = sale._id; l.collectedAt = new Date(); l.collectedBy = user._id; l.collectedByName = collectedByName; l.collectorIdChecked = idChecked;
    log(l, 'COLLECTED', user._id, `Collected by ${collectedByName}`);
    await l.save({ session });
    await AuditLog.create([{ businessId, branchId: l.branchId, userId: user._id, action: 'layaway.collect', entityType: 'Layaway', entityId: l._id, newValue: { collectedByName, idChecked, saleId: sale._id } }], { session });
    return { layaway: l, saleId: sale._id };
  });

  try { require('./crm.service').onSaleCompleted(businessId, out.saleId); } catch (e) { console.error('[crm] capture hook failed', e.message); }
  etimsService.kickForSale(businessId, out.saleId);
  return out.layaway;
}

async function ensureFeeProduct(businessId, session) {
  let p = await Product.findOne({ businessId, sku: FEE_SKU }).session(session);
  if (!p) {
    [p] = await Product.create([{ businessId, name: 'Layaway cancellation fee', sku: FEE_SKU, productType: 'service', unit: 'service', trackInventory: false, costPrice: 0, sellingPrice: 0, taxRate: 0, status: 'active' }], { session });
  }
  return p;
}

/**
 * Cancel and unwind: stock and serials go back on sale, the customer is refunded what they paid minus the cancellation
 * fee, and the fee is invoiced as income. A manager does this (it moves money).
 *  - customer cancels (default): fee = business % of what was paid. The manager may waive it (waiveFee) with the reason.
 *  - the shop cancels (cancelledByCustomer=false, e.g. item faulty or unavailable): no fee, full refund.
 */
async function cancel(businessId, user, id, { reason, cancelledByCustomer = true, waiveFee = false, refundMethod, refundReference, refundProvider }) {
  const out = await inTx(async (session) => {
    const l = await load(businessId, id, session);
    if (l.status !== 'ACTIVE') throw ApiError.conflict(`This layaway is ${l.status}`, 'INVALID_LAYAWAY_STATE');
    recalc(l);
    const paid = l.paid;
    const fee = (!cancelledByCustomer || waiveFee) ? 0 : feeFor(paid, l.terms?.cancellationFeePercent ?? 10);
    const refund = paid - fee;
    if (refund > 0 && !refundMethod) throw ApiError.badRequest('Choose how the refund is paid out', 'REFUND_METHOD_REQUIRED');

    for (const it of l.items) {
      if (it.stockReserved) await releaseReserved({ businessId, branchId: l.branchId, productId: it.productId, variantId: it.variantId || null, quantity: it.quantity, session });
      if (it.serialNumbers?.length) await serialService.releaseFromLayaway({ businessId, layawayId: l._id, serials: it.serialNumbers, userId: user._id, session });
    }

    if (refund > 0) await takePayment({ businessId, user, l, type: 'REFUND', method: refundMethod, amount: refund, reference: refundReference, provider: refundProvider, session });

    let feeSaleId;
    if (fee > 0) {
      const business = await Business.findById(businessId).session(session);
      const customer = await Customer.findOne({ _id: l.customerId, businessId }).session(session);
      const feeProduct = await ensureFeeProduct(businessId, session);
      const sale = await createInvoiceSale({
        business, branchId: l.branchId, user, session, customer, paid: fee, source: 'LAYAWAY', links: { layawayId: l._id },
        items: [{ productId: feeProduct._id, nameSnapshot: 'Layaway cancellation fee', skuSnapshot: FEE_SKU, quantity: 1, unitPrice: fee, costPriceSnapshot: 0, discount: 0, taxRate: 0, taxAmount: 0, total: fee, refundedQuantity: 0, serialNumbers: [] }],
        totals: { subtotal: fee, itemDiscount: 0, tax: 0, total: fee },
        payments: [{ method: 'OTHER', amount: fee, reference: `Kept from layaway ${l.number} payments` }],
        notes: `Cancellation fee for layaway ${l.number}`, extraReceiptLines: [`Layaway ${l.number} cancelled`],
      });
      feeSaleId = sale._id;
    }

    l.status = 'CANCELLED'; l.cancelledAt = new Date(); l.cancelledBy = user._id; l.cancelReason = reason; l.cancelledByCustomer = !!cancelledByCustomer;
    l.feeRetained = fee; l.feeSaleId = feeSaleId; l.refundedOnCancel = refund; l.balance = 0;
    log(l, 'CANCELLED', user._id, `${reason} (fee ${fee}, refunded ${refund})`);
    await l.save({ session });
    await AuditLog.create([{ businessId, branchId: l.branchId, userId: user._id, action: 'layaway.cancel', entityType: 'Layaway', entityId: l._id, newValue: { reason, fee, refund, cancelledByCustomer: !!cancelledByCustomer } }], { session });
    return { layaway: l, feeSaleId };
  });
  if (out.feeSaleId) { try { require('./crm.service').onSaleCompleted(businessId, out.feeSaleId); } catch (e) { console.error('[crm] capture hook failed', e.message); } etimsService.kickForSale(businessId, out.feeSaleId); }
  return out.layaway;
}

async function getLayaway(businessId, id) { return load(businessId, id); }

async function list(businessId, { branchId, customerId, status, overdue, search, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (customerId) filter.customerId = customerId;
  if (status) filter.status = status;
  if (overdue) { filter.status = 'ACTIVE'; filter.dueDate = { $lt: new Date() }; }
  if (search) {
    const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: re }, { customerName: re }, { customerPhone: re }];
  }
  const [items, total] = await Promise.all([
    Layaway.find(filter).select('-history -payments -items').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Layaway.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/** Receivable and liability picture, plus revenue and fees recognised in the period. */
async function summary(businessId, { from, to, branchId }) {
  const oid = (v) => new mongoose.Types.ObjectId(String(v));
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY);
  const base = { businessId: oid(businessId) };
  if (branchId) base.branchId = oid(branchId);
  const now = new Date();

  const [active, completed, cancelled] = await Promise.all([
    Layaway.aggregate([
      { $match: { ...base, status: 'ACTIVE' } },
      { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$total' }, depositsHeld: { $sum: '$paid' }, balanceOwing: { $sum: '$balance' }, overdue: { $sum: { $cond: [{ $lt: ['$dueDate', now] }, 1, 0] } } } },
    ]),
    Sale.aggregate([
      { $match: { ...base, source: 'LAYAWAY', saleStatus: 'COMPLETED', soldAt: { $gte: start, $lte: end } } },
      { $unwind: '$items' },
      { $group: {
        _id: null, sales: { $addToSet: { $cond: [{ $eq: ['$items.skuSnapshot', FEE_SKU] }, '$$REMOVE', '$_id'] } },
        feeIncome: { $sum: { $cond: [{ $eq: ['$items.skuSnapshot', FEE_SKU] }, '$items.total', 0] } },
        revenue: { $sum: { $cond: [{ $eq: ['$items.skuSnapshot', FEE_SKU] }, 0, '$items.total'] } },
        tax: { $sum: '$items.taxAmount' },
        cost: { $sum: { $multiply: ['$items.costPriceSnapshot', '$items.quantity'] } },
      } },
    ]),
    Layaway.aggregate([{ $match: { ...base, status: 'CANCELLED', cancelledAt: { $gte: start, $lte: end } } }, { $group: { _id: null, count: { $sum: 1 }, feesRetained: { $sum: '$feeRetained' }, refunded: { $sum: '$refundedOnCancel' } } }]),
  ]);
  const a = active[0] || { count: 0, value: 0, depositsHeld: 0, balanceOwing: 0, overdue: 0 };
  const c = completed[0] || { sales: [], feeIncome: 0, revenue: 0, tax: 0, cost: 0 };
  const x = cancelled[0] || { count: 0, feesRetained: 0, refunded: 0 };
  const cents = (n) => Math.round(n) / 100;
  return {
    from: start, to: end,
    active: { count: a.count, value: cents(a.value), depositsHeld: cents(a.depositsHeld), balanceOwing: cents(a.balanceOwing), overdue: a.overdue },
    collected: { invoices: c.sales.length, revenue: cents(c.revenue), tax: cents(c.tax), cost: cents(c.cost), grossProfit: cents(c.revenue - c.tax - c.cost) },
    cancelled: { count: x.count, feesRetained: cents(x.feesRetained), feesInvoiced: cents(c.feeIncome), refunded: cents(x.refunded) },
  };
}

module.exports = { create, recordPayment, extend, collect, cancel, getLayaway, list, summary, recalc, minDeposit, feeFor, termsFor, FEE_SKU };