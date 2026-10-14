const mongoose = require('mongoose');
const RepairJob = require('../models/RepairJob');
const SerialNumber = require('../models/SerialNumber');
const WarrantyClaim = require('../models/WarrantyClaim');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const Payment = require('../models/Payment');
const Sale = require('../models/Sale');
const Receipt = require('../models/Receipt');
const CashShift = require('../models/CashShift');
const User = require('../models/User');
const mpesaService = require('./mpesa.service');
const etimsService = require('./etims.service');
const { computeLineItem, computeSaleTotals } = require('./sale-pricing.util');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { normalizeSerial } = require('../utils/imei');
const { hasPermission } = require('../utils/permissionCheck');
const { applyStockChange } = require('./inventory.service');
const batchService = require('./batch.service');
const { event } = require('./serial.service');

async function inTx(fn) {
  const session = await mongoose.startSession();
  try { let out; await session.withTransaction(async () => { out = await fn(session); }); return out; } finally { session.endSession(); }
}

/** One priced line for the job, using the SAME tax maths as a till sale. */
function jobLines(job) {
  const lines = [];
  if (job.labour > 0) lines.push({ kind: 'LABOUR', quantity: 1, unitPrice: job.labour, taxRate: job.labourTaxRate || 0 });
  for (const p of job.parts) lines.push({ kind: 'PART', part: p, quantity: p.quantity, unitPrice: p.unitPrice, taxRate: p.taxRate || 0 });
  return lines.map((l) => ({ ...l, ...computeLineItem({ unitPrice: l.unitPrice, quantity: l.quantity, discount: 0, taxRate: l.taxRate, taxInclusive: job.taxInclusive !== false }) }));
}

/** Server-side money maths. Warranty repairs cost the customer nothing. */
function recalc(job) {
  const lines = jobLines(job);
  job.partsTotal = job.parts.reduce((s, p) => s + Math.round(p.quantity * p.unitPrice), 0);
  job.tax = job.isWarrantyRepair ? 0 : lines.reduce((s, l) => s + l.taxAmount, 0);
  job.total = job.isWarrantyRepair ? 0 : lines.reduce((s, l) => s + l.lineTotal, 0);
  job.paid = job.payments.reduce((s, p) => s + (p.type === 'REFUND' ? -p.amount : p.amount), 0);
  job.balance = job.total - job.paid - (job.waived || 0);
}
const log = (job, status, by, note) => job.history.push({ at: new Date(), status, by, note });
const load = async (businessId, id, session) => {
  const q = RepairJob.findOne({ _id: id, businessId });
  const job = await (session ? q.session(session) : q);
  if (!job) throw ApiError.notFound('Repair job not found');
  return job;
};

/** Intake at the counter (also used by an approved warranty repair). */
async function createJob(businessId, branchId, userId, input, session) {
  const run = async (s) => {
    let { customerId, customerName, customerPhone } = input;
    if (customerId) {
      const c = await Customer.findOne({ _id: customerId, businessId }).session(s);
      if (!c) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
      customerName = customerName || c.name; customerPhone = customerPhone || c.phone;
    }
    if (!customerName || !customerPhone) throw ApiError.badRequest('Customer name and phone are required so we can tell them when the device is ready', 'CONTACT_REQUIRED');

    const business = await Business.findById(businessId).select('taxSettings vatRegistered').session(s);
    const taxInclusive = business?.taxSettings?.taxInclusive !== false;
    const labourTaxRate = business?.vatRegistered ? (business?.taxSettings?.defaultTaxRate ?? 0) : 0;

    const device = { ...(input.device || {}) };
    let serialId; let productId;
    if (device.serialNumber) {
      device.serialNumber = normalizeSerial(device.serialNumber);
      const unit = await SerialNumber.findOne({ businessId, serialNumber: device.serialNumber }).session(s);
      if (unit) { serialId = unit._id; productId = unit.productId; }
    }
    if (serialId) {
      const open = await RepairJob.findOne({ businessId, serialId, status: { $nin: ['COLLECTED', 'CANCELLED', 'UNREPAIRABLE'] } }).select('jobNumber').session(s);
      if (open) throw ApiError.conflict(`This device is already in for repair (${open.jobNumber})`, 'REPAIR_ALREADY_OPEN');
    }
    const seq = await nextSequence(businessId, 'repair:business', s);
    const [job] = await RepairJob.create([{
      businessId, branchId, jobNumber: `RPR-${pad(seq)}`, customerId, customerName, customerPhone, device, serialId, productId, taxInclusive, labourTaxRate,
      fault: input.fault, technicianId: input.technicianId, promisedDate: input.promisedDate,
      isWarrantyRepair: !!input.isWarrantyRepair, warrantyClaimId: input.warrantyClaimId,
      status: 'RECEIVED', history: [{ at: new Date(), status: 'RECEIVED', by: userId }], createdBy: userId,
    }], { session: s });
    if (serialId) {
      await SerialNumber.updateOne({ _id: serialId }, { $push: { history: event('REPAIR_IN', { by: userId, refType: 'RepairJob', refId: job._id }) } }, { session: s });
    }
    await AuditLog.create([{ businessId, branchId, userId, action: 'repair.create', entityType: 'RepairJob', entityId: job._id, newValue: { jobNumber: job.jobNumber, warranty: job.isWarrantyRepair } }], { session: s });
    return job;
  };
  return session ? run(session) : inTx(run);
}

/**
 * Diagnosis and estimate. Labour is set; parts are added/removed (prices come from the product, never the client).
 * Issued parts cannot be removed. If the job was already approved and the total goes UP, it goes back to
 * AWAITING_APPROVAL: extra work always needs the customer's fresh approval.
 */
async function updateEstimate(businessId, userId, id, { diagnosis, labour, technicianId, promisedDate, addParts = [], removePartIds = [] }) {
  return inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (!['RECEIVED', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'].includes(job.status)) {
      throw ApiError.conflict(`The estimate cannot be changed while the job is ${job.status}`, 'INVALID_REPAIR_STATE');
    }
    const before = job.status;
    if (diagnosis !== undefined) job.diagnosis = diagnosis;
    if (labour !== undefined) job.labour = labour;
    if (technicianId !== undefined) job.technicianId = technicianId;
    if (promisedDate !== undefined) job.promisedDate = promisedDate;

    for (const pid of removePartIds) {
      const part = job.parts.id(pid);
      if (!part) throw ApiError.badRequest('Part line not found', 'PART_NOT_FOUND');
      if (part.issued) throw ApiError.conflict(`${part.nameSnapshot} has already been issued. Return it to stock first.`, 'PART_ALREADY_ISSUED');
      part.deleteOne();
    }
    for (const a of addParts) {
      const product = await Product.findOne({ _id: a.productId, businessId, status: 'active' }).session(session);
      if (!product) throw ApiError.badRequest('Part product not found', 'PRODUCT_NOT_FOUND');
      if (product.trackSerialNumber) throw ApiError.badRequest(`${product.name} is serial-tracked and cannot be used as a repair part yet`, 'UNSUPPORTED_PART');
      job.parts.push({ productId: product._id, variantId: a.variantId || null, nameSnapshot: product.name, quantity: a.quantity, unitPrice: product.sellingPrice, cost: product.costPrice, taxRate: product.taxRate || 0 });
    }
    recalc(job);

    const wasApproved = ['APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'].includes(job.status);
    if (job.isWarrantyRepair) {
      if (job.status === 'RECEIVED' || job.status === 'DIAGNOSED' || job.status === 'AWAITING_APPROVAL') { job.status = 'APPROVED'; job.approvedAt = new Date(); job.approvedBy = userId; job.approvalChannel = 'IN_PERSON'; job.approvalNote = 'Warranty repair'; }
    } else if (wasApproved) {
      if (job.total > job.approvedTotal) { job.status = 'AWAITING_APPROVAL'; log(job, 'AWAITING_APPROVAL', userId, `Estimate increased from ${job.approvedTotal} to ${job.total} cents: customer must approve the extra work`); }
    } else {
      job.status = 'AWAITING_APPROVAL';
    }
    if (job.status !== before && !(wasApproved && job.status === 'AWAITING_APPROVAL')) log(job, job.status, userId, 'Estimate updated');
    await job.save({ session });
    await AuditLog.create([{ businessId, branchId: job.branchId, userId, action: 'repair.estimate', entityType: 'RepairJob', entityId: job._id, newValue: { total: job.total } }], { session });
    return job;
  });
}

/** Record that the customer approved the estimate (in person, by phone, SMS or WhatsApp). */
async function recordApproval(businessId, userId, id, { channel, note }) {
  const job = await load(businessId, id);
  if (job.status !== 'AWAITING_APPROVAL') throw ApiError.conflict(`Job is ${job.status}, not awaiting approval`, 'INVALID_REPAIR_STATE');
  if (job.total <= 0 && !job.isWarrantyRepair) throw ApiError.badRequest('Add a labour charge or parts before asking for approval', 'EMPTY_ESTIMATE');
  const hadWork = job.parts.some((p) => p.issued);
  job.status = hadWork ? 'IN_PROGRESS' : 'APPROVED';
  job.approvedTotal = job.total; job.approvedAt = new Date(); job.approvedBy = userId; job.approvalChannel = channel; job.approvalNote = note;
  log(job, job.status, userId, `Customer approved ${job.total} cents via ${channel}${note ? `: ${note}` : ''}`);
  await job.save();
  await AuditLog.create({ businessId, branchId: job.branchId, userId, action: 'repair.approval', entityType: 'RepairJob', entityId: job._id, newValue: { channel, total: job.total } });
  return job;
}

/** Take a part out of stock for this job (FEFO for batch-tracked parts). Only after the customer approved. */
async function issuePart(businessId, userId, id, partId) {
  return inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (!['APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'].includes(job.status)) throw ApiError.conflict('Parts can only be issued once the estimate is approved', 'INVALID_REPAIR_STATE');
    const part = job.parts.id(partId);
    if (!part) throw ApiError.badRequest('Part line not found', 'PART_NOT_FOUND');
    if (part.issued) throw ApiError.conflict('This part has already been issued', 'PART_ALREADY_ISSUED');
    const product = await Product.findOne({ _id: part.productId, businessId }).session(session);
    if (!product) throw ApiError.notFound('Part product not found');

    if (product.trackInventory) {
      await applyStockChange({
        businessId, branchId: job.branchId, productId: part.productId, variantId: part.variantId || null, quantityDelta: -part.quantity,
        type: 'ADJUSTMENT_OUT', referenceType: 'RepairJob', referenceId: job._id, reason: `Repair ${job.jobNumber}: part issued`, performedBy: userId, session,
      });
    }
    if (product.trackBatch) {
      const biz = await Business.findById(businessId).select('featureSettings').session(session);
      part.batchAllocations = await batchService.allocateForSale({
        businessId, branchId: job.branchId, productId: part.productId, variantId: part.variantId || null, quantity: part.quantity,
        allowUnbatchedRemainder: !biz?.featureSettings?.quarantineManagement, productName: part.nameSnapshot, session,
      });
    }
    part.issued = true; part.issuedAt = new Date(); part.issuedBy = userId;
    if (job.status !== 'IN_PROGRESS') { job.status = 'IN_PROGRESS'; log(job, 'IN_PROGRESS', userId, `Part issued: ${part.nameSnapshot}`); }
    await job.save({ session });
    return job;
  });
}

/** Put an unused part back (job cancelled or part not needed). */
async function returnPart(businessId, userId, id, partId) {
  return inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (['READY', 'COLLECTED'].includes(job.status)) throw ApiError.conflict('Parts cannot be returned once the job is ready', 'INVALID_REPAIR_STATE');
    const part = job.parts.id(partId);
    if (!part) throw ApiError.badRequest('Part line not found', 'PART_NOT_FOUND');
    if (!part.issued) throw ApiError.conflict('This part was never issued', 'PART_NOT_ISSUED');
    const product = await Product.findOne({ _id: part.productId, businessId }).session(session);
    if (product?.trackInventory) {
      await applyStockChange({
        businessId, branchId: job.branchId, productId: part.productId, variantId: part.variantId || null, quantityDelta: part.quantity,
        type: 'RETURN', referenceType: 'RepairJob', referenceId: job._id, reason: `Repair ${job.jobNumber}: unused part returned`, performedBy: userId, session, allowNegative: true,
      });
    }
    if (part.batchAllocations?.length) {
      const notSellable = await batchService.restoreAllocations(businessId, { batchAllocations: part.batchAllocations, quantity: part.quantity }, session);
      if (notSellable > 0 && product?.trackInventory) {
        await applyStockChange({
          businessId, branchId: job.branchId, productId: part.productId, variantId: part.variantId || null, quantityDelta: -notSellable,
          type: 'ADJUSTMENT_OUT', referenceType: 'RepairJob', referenceId: job._id, reason: `Repair ${job.jobNumber}: returned part belongs to a held or expired batch`, performedBy: userId, session, allowNegative: true,
        });
      }
    }
    part.deleteOne();
    recalc(job);
    await job.save({ session });
    return job;
  });
}

const TRANSITIONS = {
  startWork: { from: ['APPROVED', 'AWAITING_PARTS'], to: 'IN_PROGRESS' },
  awaitParts: { from: ['APPROVED', 'IN_PROGRESS'], to: 'AWAITING_PARTS' },
  ready: { from: ['IN_PROGRESS'], to: 'READY' },
  unrepairable: { from: ['RECEIVED', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'], to: 'UNREPAIRABLE' },
};

async function transition(businessId, userId, id, action, note) {
  const t = TRANSITIONS[action];
  if (!t) throw ApiError.badRequest('Unknown action', 'INVALID_ACTION');
  const job = await load(businessId, id);
  if (!t.from.includes(job.status)) throw ApiError.conflict(`Cannot do "${action}" while the job is ${job.status}`, 'INVALID_REPAIR_STATE');
  if (t.to === 'READY' && job.status === 'IN_PROGRESS' && !job.parts.every((p) => p.issued)) {
    throw ApiError.badRequest('Issue all parts on the estimate (or remove them) before marking the job ready', 'PARTS_NOT_ISSUED');
  }
  job.status = t.to; log(job, t.to, userId, note);
  await job.save();
  await AuditLog.create({ businessId, branchId: job.branchId, userId, action: `repair.${action}`, entityType: 'RepairJob', entityId: job._id, newValue: { note } });
  if (t.to === 'READY') require('./sms/alerts.service').onReady('repair', job).catch(() => {}); // text the customer; never blocks the workflow
  return job;
}

async function cancelJob(businessId, userId, id, { reason }) {
  const job = await load(businessId, id);
  if (['COLLECTED', 'CANCELLED'].includes(job.status)) throw ApiError.conflict(`Job is already ${job.status}`, 'INVALID_REPAIR_STATE');
  if (job.parts.some((p) => p.issued)) throw ApiError.conflict('Return the issued parts to stock before cancelling', 'PARTS_ISSUED');
  job.status = 'CANCELLED'; job.cancelReason = reason; log(job, 'CANCELLED', userId, reason);
  await job.save();
  await AuditLog.create({ businessId, branchId: job.branchId, userId, action: 'repair.cancel', entityType: 'RepairJob', entityId: job._id, newValue: { reason } });
  return job;
}

/**
 * Deposits / payments / refunds on the job. Each one becomes a real Payment record, so it shows up in the Payments
 * report and (for cash) in the cashier's shift and drawer count, exactly like money taken at the till.
 *  - CASH needs an open shift when the business requires shifts.
 *  - MPESA must be a confirmed, unused M-PESA transaction for exactly this amount (same checks as a sale).
 *  - REFUND needs the approve permission and cannot exceed what was paid.
 * Money taken before collection is a deposit (cash received, NOT yet revenue); revenue is recognised when the
 * job is collected and its invoice is created.
 */
async function recordPayment(businessId, user, id, { type, method, amount, reference }) {
  return inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (job.status === 'COLLECTED') throw ApiError.conflict('This job is closed. It was collected and invoiced.', 'INVALID_REPAIR_STATE');
    if (job.status === 'CANCELLED' && type !== 'REFUND') throw ApiError.conflict('Job is cancelled', 'INVALID_REPAIR_STATE');
    if (job.isWarrantyRepair && type !== 'REFUND') throw ApiError.badRequest('Warranty repairs are free: there is nothing to pay', 'WARRANTY_REPAIR');

    if (type === 'REFUND') {
      if (!hasPermission(user, 'repairs.approve')) throw ApiError.forbidden('Only a manager can refund a repair payment', 'FORBIDDEN');
      if (amount > job.paid) throw ApiError.badRequest('Refund is more than was paid', 'REFUND_EXCEEDS_PAID');
    } else if (job.total > 0 && amount > job.balance && job.status !== 'RECEIVED') {
      throw ApiError.badRequest('Payment is more than the balance owing', 'OVERPAYMENT');
    }

    // Shift: same rule as a sale.
    const business = await Business.findById(businessId).select('settings').session(session);
    const shift = await CashShift.findOne({ businessId, branchId: job.branchId, cashierId: user._id, status: 'OPEN' }).session(session);
    if (method === 'CASH' && business?.settings?.requireShift && !shift) {
      throw ApiError.badRequest('Open a cash shift before taking cash payments', 'SHIFT_REQUIRED');
    }

    let provider = 'manual'; let externalTransactionId; let verified = false; let metadata;
    if (method === 'MPESA' && type !== 'REFUND') {
      if (!reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED');
      const confirmed = await mpesaService.consumeForRepair(businessId, reference, amount, job._id, session);
      provider = confirmed.channel === 'MANUAL' ? 'payhero-till' : 'payhero';
      externalTransactionId = confirmed.externalTransactionId; verified = true;
      metadata = { checkoutRequestId: confirmed.checkoutRequestId, channel: confirmed.channel };
    }

    const [payment] = await Payment.create([{
      businessId, branchId: job.branchId, repairJobId: job._id, customerId: job.customerId, shiftId: shift?._id,
      method, provider, amount, reference, externalTransactionId, metadata,
      initiatedBy: user._id, status: type === 'REFUND' ? 'REFUNDED' : 'SUCCESS', completedAt: new Date(),
      ...(method === 'CASH' && type !== 'REFUND' ? { amountTendered: amount, changeGiven: 0 } : {}),
    }], { session });

    job.payments.push({ type, method, amount, reference, by: user._id, verified, paymentId: payment._id });
    recalc(job);
    await job.save({ session });
    await AuditLog.create([{ businessId, branchId: job.branchId, userId: user._id, action: 'repair.payment', entityType: 'RepairJob', entityId: job._id, newValue: { type, method, amount, reference, paymentId: payment._id } }], { session });
    return job;
  });
}

/** The service product that "Repair labour" sales lines point at. Created on first use, one per business. */
async function ensureLabourProduct(businessId, taxRate, session) {
  let product = await Product.findOne({ businessId, sku: 'REPAIR-LABOUR' }).session(session);
  if (!product) {
    [product] = await Product.create([{
      businessId, name: 'Repair labour', sku: 'REPAIR-LABOUR', productType: 'service', unit: 'service',
      trackInventory: false, costPrice: 0, sellingPrice: 0, taxRate, status: 'active',
    }], { session });
  }
  return product;
}

/**
 * Invoice for a collected repair. This is a real Sale (source REPAIR) so repair revenue, tax, parts cost and
 * margin flow into the sales, profit and cashier reports and into eTIMS like any other sale.
 *  - NO stock is moved here: parts were already issued from stock when they were used on the job.
 *  - The job's deposits/payments (already Payment records) are attached to this sale.
 *  - A balance waived by a manager is recorded as a discount on the sale.
 */
async function createSettlementSale({ business, job, user, session }) {
  const { businessId } = job;
  const branch = await Branch.findById(job.branchId).session(session);
  const labourProduct = job.labour > 0 ? await ensureLabourProduct(businessId, job.labourTaxRate || 0, session) : null;
  const partProducts = await Product.find({ businessId, _id: { $in: job.parts.map((p) => p.productId) } }).session(session);
  const productById = new Map(partProducts.map((p) => [String(p._id), p]));

  const lines = jobLines(job);
  const items = lines.map((l) => {
    if (l.kind === 'LABOUR') {
      return {
        productId: labourProduct._id, nameSnapshot: 'Repair labour', skuSnapshot: 'REPAIR-LABOUR', quantity: 1, unitPrice: l.unitPrice,
        costPriceSnapshot: 0, discount: 0, taxRate: l.taxRate, taxAmount: l.taxAmount, total: l.lineTotal, refundedQuantity: 0, serialNumbers: [],
      };
    }
    const pr = productById.get(String(l.part.productId));
    const allocs = (l.part.batchAllocations || []).map((a) => ({ batchId: a.batchId, batchNumber: a.batchNumber, expiryDate: a.expiryDate, quantity: a.quantity }));
    return {
      productId: l.part.productId, variantId: l.part.variantId || undefined, nameSnapshot: l.part.nameSnapshot, skuSnapshot: pr?.sku, barcodeSnapshot: pr?.barcode,
      quantity: l.quantity, unitPrice: l.unitPrice, costPriceSnapshot: l.part.cost || 0, discount: 0, taxRate: l.taxRate, taxAmount: l.taxAmount, total: l.lineTotal,
      refundedQuantity: 0, batchId: allocs[0]?.batchId, batchAllocations: allocs, serialNumbers: [],
    };
  });

  const totals = computeSaleTotals(lines.map((l) => ({ grossLineTotal: l.grossLineTotal, taxAmount: l.taxAmount, lineTotal: l.lineTotal, discountApplied: 0 })), job.waived || 0);
  if (totals.total !== job.paid) {
    throw ApiError.conflict('The job total, payments and waived amount do not add up. Please contact support before collecting.', 'REPAIR_TOTALS_MISMATCH');
  }

  const rSeq = await nextSequence(businessId, `receipt:branch:${job.branchId}`, session);
  const receiptNumber = `${business.receiptSettings?.receiptPrefix || 'RCT'}-${branch?.code || 'MAIN'}-${pad(rSeq)}`;
  const iSeq = await nextSequence(businessId, `invoice:branch:${job.branchId}`, session);
  const invoiceNumber = `${business.receiptSettings?.invoicePrefix || 'INV'}-${branch?.code || 'MAIN'}-${pad(iSeq)}`;
  const now = new Date();

  const [sale] = await Sale.create([{
    businessId, branchId: job.branchId, receiptNumber, invoiceNumber, customerId: job.customerId, cashierId: user._id,
    items, subtotal: totals.subtotal, itemDiscount: 0, cartDiscount: job.waived || 0, tax: totals.tax, total: totals.total,
    amountPaid: job.paid, balance: 0, paymentStatus: 'PAID', saleStatus: 'COMPLETED', source: 'REPAIR', repairJobId: job._id,
    notes: `Repair ${job.jobNumber}${job.waived ? ` (balance waived: ${job.waiveReason})` : ''}`, soldAt: now,
  }], { session });

  await Payment.updateMany({ businessId, repairJobId: job._id }, { $set: { saleId: sale._id } }, { session });

  const rs = business.receiptSettings || {};
  await Receipt.create([{
    businessId, branchId: job.branchId, saleId: sale._id, receiptNumber, invoiceNumber, soldAt: now,
    receiptData: {
      business: {
        name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin,
        footerMessage: rs.footerMessage, headerMessage: rs.headerMessage, logo: rs.showLogo ? business.logo : undefined,
        showKraPin: rs.showKraPin ?? true, showCashierName: rs.showCashierName ?? true, showMpesaReceiptCode: rs.showMpesaReceiptCode ?? true,
        customLines: [...(rs.customLines || []), `Repair job ${job.jobNumber}`], paperWidth: rs.paperWidth || '80mm',
      },
      branch: { name: branch?.name, phone: branch?.phone },
      cashier: { name: user.name },
      customer: { name: job.customerName, phone: job.customerPhone },
      items: items.map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity, unitPrice: i.unitPrice, discount: 0, taxRate: i.taxRate, taxAmount: i.taxAmount, total: i.total })),
      subtotal: totals.subtotal, itemDiscount: 0, cartDiscount: job.waived || 0, tax: totals.tax, total: totals.total,
      payments: job.payments.filter((p) => p.type !== 'REFUND').map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
      amountTendered: 0, changeGiven: 0, balance: 0, paymentStatus: 'PAID',
    },
  }], { session });

  await AuditLog.create([{ businessId, branchId: job.branchId, userId: user._id, action: 'sale.create', entityType: 'Sale', entityId: sale._id, newValue: { receiptNumber, total: totals.total, source: 'REPAIR', jobNumber: job.jobNumber } }], { session });
  await etimsService.enqueueForSale(businessId, job.branchId, sale._id, { session });
  return sale;
}

/**
 * Hand the device over. The balance must be settled (or waived by a manager with a reason). On collection the job
 * is invoiced: a Sale + receipt are created, so the money counts as revenue from this moment. Warranty repairs
 * (nothing to charge) are closed without an invoice.
 */
async function collect(businessId, user, id, { collectedByName, idChecked = false, waiveBalance = false, waiveReason }) {
  const job = await inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (job.status !== 'READY') throw ApiError.conflict(`Job is ${job.status}, not READY`, 'INVALID_REPAIR_STATE');
    recalc(job);
    if (job.balance < 0) throw ApiError.conflict('The customer has overpaid. Record a refund first.', 'OVERPAID');
    if (job.balance > 0) {
      if (!waiveBalance) throw ApiError.conflict(`Balance of ${job.balance} cents is still owing`, 'BALANCE_OWING');
      if (!hasPermission(user, 'repairs.approve')) throw ApiError.forbidden('Only a manager can waive a balance', 'FORBIDDEN');
      if (!waiveReason) throw ApiError.badRequest('A reason is required to waive the balance', 'REASON_REQUIRED');
      job.waived = job.balance; job.waiveReason = waiveReason;
      recalc(job);
    }

    if (job.total > 0) {
      const business = await Business.findById(businessId).session(session);
      const sale = await createSettlementSale({ business, job, user, session });
      job.settlementSaleId = sale._id;
    }

    job.status = 'COLLECTED'; job.collectedAt = new Date(); job.collectedBy = user._id; job.collectedByName = collectedByName; job.collectorIdChecked = idChecked;
    log(job, 'COLLECTED', user._id, `Collected by ${collectedByName}`);
    await job.save({ session });
    if (job.serialId) await SerialNumber.updateOne({ _id: job.serialId }, { $push: { history: event('REPAIR_OUT', { by: user._id, refType: 'RepairJob', refId: job._id }) } }, { session });
    if (job.warrantyClaimId) await WarrantyClaim.updateOne({ _id: job.warrantyClaimId, status: 'APPROVED' }, { $set: { status: 'RESOLVED', resolvedAt: new Date() } }, { session });
    await AuditLog.create([{ businessId, branchId: job.branchId, userId: user._id, action: 'repair.collect', entityType: 'RepairJob', entityId: job._id, newValue: { collectedByName, idChecked, waived: job.waived, saleId: job.settlementSaleId } }], { session });
    return job;
  });

  // After commit: same follow-ups as a till sale (never block or fail the handover).
  if (job.settlementSaleId) {
    try { require('./crm.service').onSaleCompleted(businessId, job.settlementSaleId); } catch (e) { console.error('[crm] capture hook failed', e.message); }
    etimsService.kickForSale(businessId, job.settlementSaleId);
  }
  return job;
}

/**
 * Money picture for repairs between two dates (default last 30 days). Deposits held are cash received for jobs
 * that are not collected yet: they are a liability, not revenue. Revenue is what was invoiced on collection.
 */
async function summary(businessId, { from, to, branchId }) {
  const oid = (v) => new mongoose.Types.ObjectId(String(v));
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400000);
  const base = { businessId: oid(businessId) };
  if (branchId) base.branchId = oid(branchId);

  const [byStatus, open, revenue] = await Promise.all([
    RepairJob.aggregate([{ $match: { ...base, createdAt: { $gte: start, $lte: end } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    RepairJob.aggregate([
      { $match: { ...base, status: { $nin: ['COLLECTED', 'CANCELLED'] } } },
      { $group: { _id: null, jobs: { $sum: 1 }, depositsHeld: { $sum: '$paid' }, estimatedTotal: { $sum: '$total' } } },
    ]),
    Sale.aggregate([
      { $match: { ...base, source: 'REPAIR', saleStatus: 'COMPLETED', soldAt: { $gte: start, $lte: end } } },
      { $unwind: '$items' },
      { $group: {
        _id: null, sales: { $addToSet: '$_id' }, revenue: { $sum: '$items.total' }, tax: { $sum: '$items.taxAmount' },
        labour: { $sum: { $cond: [{ $eq: ['$items.skuSnapshot', 'REPAIR-LABOUR'] }, '$items.total', 0] } },
        partsCost: { $sum: { $multiply: ['$items.costPriceSnapshot', '$items.quantity'] } },
      } },
    ]),
  ]);
  const r = revenue[0] || { sales: [], revenue: 0, tax: 0, labour: 0, partsCost: 0 };
  const o = open[0] || { jobs: 0, depositsHeld: 0, estimatedTotal: 0 };
  const cents = (n) => Math.round(n) / 100;
  return {
    from: start, to: end,
    jobsCreatedByStatus: Object.fromEntries(byStatus.map((x) => [x._id, x.count])),
    openJobs: o.jobs, depositsHeld: cents(o.depositsHeld), openJobsEstimatedValue: cents(o.estimatedTotal),
    invoices: r.sales.length, revenue: cents(r.revenue), labourRevenue: cents(r.labour), partsRevenue: cents(r.revenue - r.labour),
    partsCost: cents(r.partsCost), grossProfit: cents(r.revenue - r.tax - r.partsCost), taxCollected: cents(r.tax),
  };
}

async function listJobs(businessId, { branchId, status, search, overdue, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (status) filter.status = status;
  if (overdue) { filter.promisedDate = { $lt: new Date() }; filter.status = { $in: ['RECEIVED', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'] }; }
  if (search) {
    const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ jobNumber: re }, { customerName: re }, { customerPhone: re }, { 'device.serialNumber': re }, { 'device.model': re }];
  }
  const [items, total] = await Promise.all([
    RepairJob.find(filter).select('-history -payments -parts').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    RepairJob.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/** Devices finished but not collected for `days` days. */
async function uncollected(businessId, { days = 14, branchId }) {
  const filter = { businessId, status: 'READY', updatedAt: { $lte: new Date(Date.now() - days * 86400000) } };
  if (branchId) filter.branchId = branchId;
  return RepairJob.find(filter).select('jobNumber customerName customerPhone device updatedAt balance total').sort({ updatedAt: 1 }).limit(500);
}

const getJob = (businessId, id) => load(businessId, id);

/** Staff pressed "send the ready SMS again" (at most once an hour per job). */
async function notifyReady(businessId, id) {
  const job = await load(businessId, id);
  if (job.status !== 'READY') throw ApiError.conflict('The customer can only be notified once the job is READY', 'INVALID_REPAIR_STATE');
  return require('./sms/alerts.service').onReady('repair', job, { businessId, manual: true });
}

module.exports = { notifyReady, summary, createJob, updateEstimate, recordApproval, issuePart, returnPart, transition, cancelJob, recordPayment, collect, listJobs, uncollected, getJob, recalc };