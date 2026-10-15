const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Supplier = require('../models/Supplier');
const SupplierPayment = require('../models/SupplierPayment');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { fromCents } = require('../utils/money');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const DAY = 86400000;
const statusFor = (p) => (p.balance <= 0 ? 'PAID' : p.amountPaid > 0 ? 'PARTIAL' : 'UNPAID');
const dueOf = (p) => p.dueDate || p.invoiceDate || p.purchaseDate || p.createdAt;

// ---------------------------------------------------------------- supplier invoice matching
/**
 * Record what the SUPPLIER's invoice says and compare it with what we ordered (purchase total).
 * variance = invoice total - purchase total. 0 -> MATCHED, otherwise VARIANCE (needs approval before it is paid).
 */
async function recordSupplierInvoice(businessId, userId, purchaseId, { invoiceNumber, invoiceDate, dueDate, supplierInvoiceTotal, note }) {
  const purchase = await Purchase.findOne({ _id: purchaseId, businessId });
  if (!purchase) throw ApiError.notFound('Purchase not found');
  if (purchase.invoiceMatchStatus === 'VARIANCE_APPROVED') throw ApiError.conflict('The variance on this invoice was already approved', 'ALREADY_APPROVED');
  if (invoiceNumber) purchase.invoiceNumber = invoiceNumber;
  if (invoiceDate) purchase.invoiceDate = invoiceDate;
  if (dueDate) purchase.dueDate = dueDate;
  purchase.supplierInvoiceTotal = supplierInvoiceTotal;
  purchase.invoiceVariance = supplierInvoiceTotal - purchase.total;
  purchase.invoiceMatchStatus = purchase.invoiceVariance === 0 ? 'MATCHED' : 'VARIANCE';
  purchase.invoiceMatchNote = note;
  purchase.invoiceRecordedAt = new Date();
  purchase.invoiceRecordedBy = userId;
  await purchase.save();
  await AuditLog.create({ businessId, branchId: purchase.branchId, userId, action: 'purchase.invoice', entityType: 'Purchase', entityId: purchase._id, newValue: { supplierInvoiceTotal, variance: purchase.invoiceVariance } });
  return purchase;
}

/**
 * Approve a variance. adjustPayable=true makes the payable follow the supplier's invoice (purchase total, balance and,
 * once goods are received, the supplier's balance move by the variance); false accepts the difference without touching
 * the books (e.g. it is settled by a credit note elsewhere).
 */
async function approveInvoiceVariance(businessId, userId, purchaseId, { note, adjustPayable = false }) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const purchase = await Purchase.findOne({ _id: purchaseId, businessId }).session(session);
      if (!purchase) throw ApiError.notFound('Purchase not found');
      if (purchase.invoiceMatchStatus !== 'VARIANCE') throw ApiError.conflict('There is no open variance on this purchase', 'NO_VARIANCE');
      const variance = purchase.invoiceVariance;
      if (adjustPayable) {
        if (purchase.total + variance < purchase.amountPaid) throw ApiError.badRequest('The adjusted total would be below what was already paid', 'INVALID_ADJUSTMENT');
        purchase.total += variance;
        purchase.balance = purchase.total - purchase.amountPaid;
        purchase.paymentStatus = statusFor(purchase);
        if (purchase.receivedStatus === 'RECEIVED') await Supplier.updateOne({ _id: purchase.supplierId }, { $inc: { currentBalance: variance } }, { session });
      }
      purchase.invoiceMatchStatus = 'VARIANCE_APPROVED';
      purchase.invoiceMatchNote = [purchase.invoiceMatchNote, note].filter(Boolean).join(' | ');
      await purchase.save({ session });
      await AuditLog.create([{ businessId, branchId: purchase.branchId, userId, action: 'purchase.invoice.approve', entityType: 'Purchase', entityId: purchase._id, newValue: { variance, adjustPayable, note } }], { session });
      result = purchase;
    });
    return result;
  } finally { session.endSession(); }
}

// ---------------------------------------------------------------- supplier payments (allocated to invoices)
/**
 * Pay a supplier. `allocations` [{purchaseId, amount}] pays specific invoices; without it the payment settles the
 * OLDEST DUE invoices first. A payment can never exceed what is owed on the allocated invoices.
 * Purchase.balance / paymentStatus and Supplier.currentBalance move together, in one transaction.
 */
async function recordSupplierPayment(businessId, userId, { supplierId, amount, method = 'CASH', reference, paidAt, notes, allocations, branchId }) {
  const supplier = await Supplier.findOne({ _id: supplierId, businessId });
  if (!supplier) throw ApiError.badRequest('Supplier not found', 'INVALID_SUPPLIER');
  const seq = await nextSequence(businessId, 'supplierPayment:business', undefined);
  const paymentNumber = `SP-${pad(seq)}`;

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      let plan = [];
      if (allocations?.length) {
        const merged = new Map();
        allocations.forEach((a) => merged.set(String(a.purchaseId), (merged.get(String(a.purchaseId)) || 0) + a.amount));
        const sum = [...merged.values()].reduce((s, n) => s + n, 0);
        if (sum !== amount) throw ApiError.badRequest('Allocations must add up to the payment amount', 'ALLOCATION_MISMATCH');
        plan = [...merged.entries()].map(([purchaseId, amt]) => ({ purchaseId, amount: amt }));
      } else {
        const open = await Purchase.find({ businessId, supplierId, balance: { $gt: 0 } }).session(session);
        open.sort((a, b) => new Date(dueOf(a)) - new Date(dueOf(b)));
        let left = amount;
        for (const p of open) {
          if (left <= 0) break;
          const take = Math.min(left, p.balance);
          plan.push({ purchaseId: String(p._id), amount: take });
          left -= take;
        }
        if (left > 0) throw ApiError.badRequest(`Payment is ${fromCents(left)} more than what is owed to this supplier`, 'OVERPAYMENT');
      }

      const done = [];
      for (const line of plan) {
        const purchase = await Purchase.findOne({ _id: line.purchaseId, businessId, supplierId }).session(session);
        if (!purchase) throw ApiError.badRequest('A purchase in the allocation does not belong to this supplier', 'INVALID_ALLOCATION');
        if (line.amount > purchase.balance) throw ApiError.badRequest(`${purchase.purchaseNumber}: payment exceeds the outstanding balance`, 'OVERPAYMENT');
        if (purchase.invoiceMatchStatus === 'VARIANCE') throw ApiError.conflict(`${purchase.purchaseNumber}: approve the supplier-invoice variance before paying`, 'VARIANCE_UNAPPROVED');
        purchase.amountPaid += line.amount;
        purchase.balance = purchase.total - purchase.amountPaid;
        purchase.paymentStatus = statusFor(purchase);
        await purchase.save({ session });
        done.push({ purchaseId: purchase._id, purchaseNumber: purchase.purchaseNumber, amount: line.amount });
      }
      await Supplier.updateOne({ _id: supplierId }, { $inc: { currentBalance: -amount } }, { session });
      const [payment] = await SupplierPayment.create([{ businessId, branchId, supplierId, paymentNumber, amount, method, reference, paidAt: paidAt || new Date(), notes, allocations: done, createdBy: userId }], { session });
      await AuditLog.create([{ businessId, branchId, userId, action: 'supplier.payment', entityType: 'SupplierPayment', entityId: payment._id, newValue: { paymentNumber, supplierId, amount, invoices: done.length } }], { session });
      result = payment;
    });
    return result;
  } finally { session.endSession(); }
}

async function voidSupplierPayment(businessId, userId, id, reason) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const payment = await SupplierPayment.findOne({ _id: id, businessId }).session(session);
      if (!payment) throw ApiError.notFound('Payment not found');
      if (payment.status === 'VOIDED') throw ApiError.conflict('This payment is already voided', 'ALREADY_VOIDED');
      for (const a of payment.allocations) {
        const purchase = await Purchase.findOne({ _id: a.purchaseId, businessId }).session(session);
        if (!purchase) continue;
        purchase.amountPaid = Math.max(0, purchase.amountPaid - a.amount);
        purchase.balance = purchase.total - purchase.amountPaid;
        purchase.paymentStatus = statusFor(purchase);
        await purchase.save({ session });
      }
      await Supplier.updateOne({ _id: payment.supplierId }, { $inc: { currentBalance: payment.amount } }, { session });
      payment.status = 'VOIDED'; payment.voidedAt = new Date(); payment.voidedBy = userId; payment.voidReason = reason;
      await payment.save({ session });
      await AuditLog.create([{ businessId, userId, action: 'supplier.payment.void', entityType: 'SupplierPayment', entityId: payment._id, newValue: { reason } }], { session });
      result = payment;
    });
    return result;
  } finally { session.endSession(); }
}

async function listSupplierPayments(businessId, { supplierId, status, from, to, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (supplierId) filter.supplierId = supplierId;
  if (status) filter.status = status;
  if (from || to) filter.paidAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [items, total] = await Promise.all([
    SupplierPayment.find(filter).populate('supplierId', 'name').sort({ paidAt: -1 }).skip((page - 1) * limit).limit(limit),
    SupplierPayment.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

// ---------------------------------------------------------------- statement + ageing
/** Running statement: invoices (purchases) add to what we owe, payments reduce it. Amounts in KES. */
async function supplierStatement(businessId, supplierId, { from, to } = {}) {
  const supplier = await Supplier.findOne({ _id: supplierId, businessId }).lean();
  if (!supplier) throw ApiError.notFound('Supplier not found');
  const [purchases, payments] = await Promise.all([
    Purchase.find({ businessId, supplierId }).select('purchaseNumber invoiceNumber invoiceDate purchaseDate createdAt dueDate total amountPaid balance invoiceMatchStatus invoiceVariance receivedStatus').lean(),
    SupplierPayment.find({ businessId, supplierId, status: 'COMPLETED' }).lean(),
  ]);
  const events = [
    ...purchases.map((p) => ({ date: p.invoiceDate || p.purchaseDate || p.createdAt, type: 'INVOICE', ref: p.invoiceNumber || p.purchaseNumber, purchaseNumber: p.purchaseNumber, dueDate: p.dueDate, debit: p.total, credit: 0, matchStatus: p.invoiceMatchStatus })),
    // payments recorded the old way (directly on a purchase) have no SupplierPayment: show them as one line per purchase
    ...purchases.map((p) => ({ p, rest: p.amountPaid - payments.reduce((s, x) => s + x.allocations.filter((a) => String(a.purchaseId) === String(p._id)).reduce((t, a) => t + a.amount, 0), 0) }))
      .filter((x) => x.rest > 0).map((x) => ({ date: x.p.purchaseDate || x.p.createdAt, type: 'PAYMENT', ref: `Payment on ${x.p.purchaseNumber}`, debit: 0, credit: x.rest })),
    ...payments.map((x) => ({ date: x.paidAt, type: 'PAYMENT', ref: x.paymentNumber, method: x.method, debit: 0, credit: x.amount })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));
  let running = 0;
  let opening = 0;
  const lines = [];
  for (const e of events) {
    running += e.debit - e.credit;
    if (from && new Date(e.date) < new Date(from)) { opening = running; continue; }
    if (to && new Date(e.date) > new Date(to)) continue;
    lines.push({ date: e.date, type: e.type, reference: e.ref, dueDate: e.dueDate, matchStatus: e.matchStatus, method: e.method, debit: fromCents(e.debit), credit: fromCents(e.credit), balance: fromCents(running) });
  }
  const outstanding = purchases.reduce((s, p) => s + p.balance, 0);
  return { supplier: { _id: supplier._id, name: supplier.name, phone: supplier.phone, paymentTerms: supplier.paymentTerms }, openingBalance: fromCents(opening), closingBalance: fromCents(running), outstandingInvoices: fromCents(outstanding), lines };
}

/** Payables ageing by due date: current (not yet due), 1-30, 31-60, 61-90, 90+ days overdue. */
async function payablesAgeing(businessId, { supplierId, asOf } = {}) {
  const now = asOf ? new Date(asOf) : new Date();
  const filter = { businessId, balance: { $gt: 0 } };
  if (supplierId) filter.supplierId = oid(supplierId);
  const purchases = await Purchase.find(filter).populate('supplierId', 'name').lean();
  const bucketOf = (days) => (days <= 0 ? 'current' : days <= 30 ? 'days1to30' : days <= 60 ? 'days31to60' : days <= 90 ? 'days61to90' : 'over90');
  const bySupplier = new Map();
  const totals = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0 };
  for (const p of purchases) {
    const days = Math.floor((now - new Date(dueOf(p))) / DAY);
    const b = bucketOf(days);
    const key = String(p.supplierId?._id || p.supplierId);
    if (!bySupplier.has(key)) bySupplier.set(key, { supplierId: p.supplierId?._id || p.supplierId, name: p.supplierId?.name, current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0, invoices: [] });
    const row = bySupplier.get(key);
    row[b] += p.balance; row.total += p.balance; totals[b] += p.balance; totals.total += p.balance;
    row.invoices.push({ purchaseId: p._id, purchaseNumber: p.purchaseNumber, invoiceNumber: p.invoiceNumber, dueDate: dueOf(p), daysOverdue: Math.max(0, days), balance: fromCents(p.balance), bucket: b });
  }
  const conv = (r) => ({ ...r, current: fromCents(r.current), days1to30: fromCents(r.days1to30), days31to60: fromCents(r.days31to60), days61to90: fromCents(r.days61to90), over90: fromCents(r.over90), total: fromCents(r.total) });
  return { asOf: now, suppliers: [...bySupplier.values()].map(conv).sort((a, b) => b.total - a.total), totals: conv(totals) };
}

module.exports = { recordSupplierInvoice, approveInvoiceVariance, recordSupplierPayment, voidSupplierPayment, listSupplierPayments, supplierStatement, payablesAgeing };
