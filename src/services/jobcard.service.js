const mongoose = require('mongoose');
const JobCard = require('../models/JobCard');
const Vehicle = require('../models/Vehicle');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const Payment = require('../models/Payment');
const Sale = require('../models/Sale');
const Receipt = require('../models/Receipt');
const CashShift = require('../models/CashShift');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const mpesaService = require('./mpesa.service');
const etimsService = require('./etims.service');
const { computeLineItem, computeSaleTotals } = require('./sale-pricing.util');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { hasPermission } = require('../utils/permissionCheck');
const { applyStockChange } = require('./inventory.service');
const batchService = require('./batch.service');

const OPEN = ['CHECKED_IN', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY'];
const EDITABLE = ['CHECKED_IN', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'];
const APPROVED_STATES = ['APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'];
const LABOUR_SKU = 'GARAGE-LABOUR';

async function inTx(fn) {
  const session = await mongoose.startSession();
  try { let out; await session.withTransaction(async () => { out = await fn(session); }); return out; } finally { session.endSession(); }
}

const labourAmount = (l) => Math.round(l.hours * l.rate);

/** Priced lines for the card, using the SAME tax maths as a till sale. */
function jobLines(job) {
  const lines = [];
  for (const l of job.labourLines) lines.push({ kind: 'LABOUR', labour: l, quantity: 1, unitPrice: labourAmount(l), taxRate: job.labourTaxRate || 0 });
  for (const p of job.parts) lines.push({ kind: 'PART', part: p, quantity: p.quantity, unitPrice: p.unitPrice, taxRate: p.taxRate || 0 });
  return lines.map((l) => ({ ...l, ...computeLineItem({ unitPrice: l.unitPrice, quantity: l.quantity, discount: 0, taxRate: l.taxRate, taxInclusive: job.taxInclusive !== false }) }));
}

/** Server-side money maths. Warranty (comeback) repairs cost the customer nothing. */
function recalc(job) {
  const lines = jobLines(job);
  job.labourTotal = job.labourLines.reduce((s, l) => s + labourAmount(l), 0);
  job.partsTotal = job.parts.reduce((s, p) => s + Math.round(p.quantity * p.unitPrice), 0);
  job.tax = job.isWarrantyRepair ? 0 : lines.reduce((s, l) => s + l.taxAmount, 0);
  job.total = job.isWarrantyRepair ? 0 : lines.reduce((s, l) => s + l.lineTotal, 0);
  job.paid = job.payments.reduce((s, p) => s + (p.type === 'REFUND' ? -p.amount : p.amount), 0);
  job.balance = job.total - job.paid - (job.waived || 0);
}
const log = (job, status, by, note) => job.history.push({ at: new Date(), status, by, note });
const load = async (businessId, id, session) => {
  const q = JobCard.findOne({ _id: id, businessId });
  const job = await (session ? q.session(session) : q);
  if (!job) throw ApiError.notFound('Job card not found');
  return job;
};
async function assertMechanic(businessId, mechanicId, session) {
  if (!mechanicId) return;
  const u = await User.findOne({ _id: mechanicId, businessId }).select('_id').session(session || null);
  if (!u) throw ApiError.badRequest('Mechanic not found', 'MECHANIC_NOT_FOUND');
}

/**
 * Check a vehicle in. One open job card per vehicle. The odometer cannot be lower than the last reading.
 * If the vehicle was collected within the work-warranty period of an earlier job, the card is linked as a COMEBACK;
 * only a manager can make a comeback free (isWarrantyRepair).
 */
async function createJob(businessId, branchId, user, input) {
  return inTx(async (session) => {
    const vehicle = await Vehicle.findOne({ _id: input.vehicleId, businessId }).session(session);
    if (!vehicle) throw ApiError.badRequest('Vehicle not found. Register it first.', 'VEHICLE_NOT_FOUND');
    if (vehicle.status !== 'active') throw ApiError.badRequest('This vehicle is inactive', 'VEHICLE_INACTIVE');
    const branch = await Branch.findOne({ _id: branchId, businessId }).select('_id').session(session);
    if (!branch) throw ApiError.badRequest('Branch not found', 'BRANCH_NOT_FOUND');

    const open = await JobCard.findOne({ businessId, vehicleId: vehicle._id, status: { $in: OPEN } }).select('jobNumber').session(session);
    if (open) throw ApiError.conflict(`This vehicle already has an open job card (${open.jobNumber})`, 'JOBCARD_ALREADY_OPEN');
    if (input.odometerIn < vehicle.odometerKm) throw ApiError.badRequest(`Odometer is lower than the last reading (${vehicle.odometerKm} km). Check the figure.`, 'ODOMETER_BACKWARDS');

    let customerId = input.customerId || vehicle.customerId; let customerName = input.customerName || vehicle.ownerName; let customerPhone = input.customerPhone || vehicle.ownerPhone;
    if (customerId) {
      const c = await Customer.findOne({ _id: customerId, businessId }).session(session);
      if (!c) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
      customerName = customerName || c.name; customerPhone = customerPhone || c.phone;
    }
    if (!customerName || !customerPhone) throw ApiError.badRequest('Customer name and phone are required so we can tell them when the vehicle is ready', 'CONTACT_REQUIRED');
    await assertMechanic(businessId, input.mechanicId, session);

    const prior = await JobCard.findOne({ businessId, vehicleId: vehicle._id, status: 'COLLECTED', workWarrantyUntil: { $gte: new Date() } }).sort({ collectedAt: -1 }).select('_id jobNumber').session(session);
    if (input.isWarrantyRepair) {
      if (!prior) throw ApiError.badRequest('A free repair is only possible when the vehicle is back within the warranty of earlier work', 'NO_WORK_WARRANTY');
      if (!hasPermission(user, 'jobcards.approve')) throw ApiError.forbidden('Only a manager can make a comeback free of charge', 'FORBIDDEN');
    }

    const business = await Business.findById(businessId).select('taxSettings vatRegistered').session(session);
    const taxInclusive = business?.taxSettings?.taxInclusive !== false;
    const labourTaxRate = business?.vatRegistered ? (business?.taxSettings?.defaultTaxRate ?? 0) : 0;

    const seq = await nextSequence(businessId, 'jobcard:business', session);
    const [job] = await JobCard.create([{
      businessId, branchId, jobNumber: `JC-${pad(seq)}`, vehicleId: vehicle._id, plate: vehicle.plateDisplay || vehicle.plate,
      vehicleLabel: [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' '),
      customerId, customerName, customerPhone, odometerIn: input.odometerIn, fuelLevel: input.fuelLevel,
      conditionNotes: input.conditionNotes, itemsLeftInCar: input.itemsLeftInCar, customerSuppliedParts: input.customerSuppliedParts,
      complaint: input.complaint, mechanicId: input.mechanicId, promisedDate: input.promisedDate,
      comebackOf: prior?._id, isWarrantyRepair: !!input.isWarrantyRepair, taxInclusive, labourTaxRate,
      status: 'CHECKED_IN', history: [{ at: new Date(), status: 'CHECKED_IN', by: user._id, note: prior ? `Comeback of ${prior.jobNumber}` : undefined }], createdBy: user._id,
    }], { session });

    if (input.odometerIn > vehicle.odometerKm) { vehicle.odometerKm = input.odometerIn; await vehicle.save({ session }); }
    await AuditLog.create([{ businessId, branchId, userId: user._id, action: 'jobcard.create', entityType: 'JobCard', entityId: job._id, newValue: { jobNumber: job.jobNumber, plate: job.plate, comebackOf: prior?._id } }], { session });
    return job;
  });
}

/**
 * Diagnosis and estimate: labour lines and parts. Part prices come from the product, never the client.
 * Issued parts and finished labour lines cannot be removed. If an approved card's total goes UP it returns to
 * AWAITING_APPROVAL: extra work always needs the customer's fresh approval (this is the classic garage dispute).
 */
async function updateEstimate(businessId, userId, id, { diagnosis, mechanicId, promisedDate, customerSuppliedParts, addLabour = [], removeLabourIds = [], addParts = [], removePartIds = [] }) {
  return inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (!EDITABLE.includes(job.status)) throw ApiError.conflict(`The estimate cannot be changed while the job card is ${job.status}`, 'INVALID_JOBCARD_STATE');
    const before = job.status;
    if (diagnosis !== undefined) job.diagnosis = diagnosis;
    if (promisedDate !== undefined) job.promisedDate = promisedDate;
    if (customerSuppliedParts !== undefined) job.customerSuppliedParts = customerSuppliedParts;
    if (mechanicId !== undefined) { await assertMechanic(businessId, mechanicId, session); job.mechanicId = mechanicId; }

    for (const lid of removeLabourIds) {
      const l = job.labourLines.id(lid);
      if (!l) throw ApiError.badRequest('Labour line not found', 'LABOUR_NOT_FOUND');
      if (l.done) throw ApiError.conflict('That labour has already been marked done', 'LABOUR_DONE');
      l.deleteOne();
    }
    for (const l of addLabour) { await assertMechanic(businessId, l.mechanicId, session); job.labourLines.push({ description: l.description, hours: l.hours ?? 1, rate: l.rate, mechanicId: l.mechanicId || job.mechanicId }); }

    for (const pid of removePartIds) {
      const part = job.parts.id(pid);
      if (!part) throw ApiError.badRequest('Part line not found', 'PART_NOT_FOUND');
      if (part.issued) throw ApiError.conflict(`${part.nameSnapshot} has already been issued. Return it to stock first.`, 'PART_ALREADY_ISSUED');
      part.deleteOne();
    }
    for (const a of addParts) {
      const product = await Product.findOne({ _id: a.productId, businessId, status: 'active' }).session(session);
      if (!product) throw ApiError.badRequest('Part product not found', 'PRODUCT_NOT_FOUND');
      if (product.trackSerialNumber) throw ApiError.badRequest(`${product.name} is serial-tracked and cannot be used as a job card part yet`, 'UNSUPPORTED_PART');
      job.parts.push({ productId: product._id, variantId: a.variantId || null, nameSnapshot: product.name, quantity: a.quantity, unitPrice: product.sellingPrice, cost: product.costPrice, taxRate: product.taxRate || 0 });
    }
    recalc(job);

    const wasApproved = APPROVED_STATES.includes(job.status);
    if (job.isWarrantyRepair) {
      if (['CHECKED_IN', 'DIAGNOSED', 'AWAITING_APPROVAL'].includes(job.status)) { job.status = 'APPROVED'; job.approvedAt = new Date(); job.approvedBy = userId; job.approvalChannel = 'IN_PERSON'; job.approvalNote = 'Work warranty comeback'; }
    } else if (wasApproved) {
      if (job.total > job.approvedTotal) { job.status = 'AWAITING_APPROVAL'; log(job, 'AWAITING_APPROVAL', userId, `Estimate increased from ${job.approvedTotal} to ${job.total} cents: customer must approve the extra work`); }
    } else {
      job.status = 'AWAITING_APPROVAL';
    }
    if (job.status !== before && !(wasApproved && job.status === 'AWAITING_APPROVAL')) log(job, job.status, userId, 'Estimate updated');
    await job.save({ session });
    await AuditLog.create([{ businessId, branchId: job.branchId, userId, action: 'jobcard.estimate', entityType: 'JobCard', entityId: job._id, newValue: { total: job.total } }], { session });
    return job;
  });
}

async function recordApproval(businessId, userId, id, { channel, note }) {
  const job = await load(businessId, id);
  if (job.status !== 'AWAITING_APPROVAL') throw ApiError.conflict(`Job card is ${job.status}, not awaiting approval`, 'INVALID_JOBCARD_STATE');
  if (job.total <= 0 && !job.isWarrantyRepair) throw ApiError.badRequest('Add labour or parts before asking for approval', 'EMPTY_ESTIMATE');
  const hadWork = job.parts.some((p) => p.issued) || job.labourLines.some((l) => l.done);
  job.status = hadWork ? 'IN_PROGRESS' : 'APPROVED';
  job.approvedTotal = job.total; job.approvedAt = new Date(); job.approvedBy = userId; job.approvalChannel = channel; job.approvalNote = note;
  log(job, job.status, userId, `Customer approved ${job.total} cents via ${channel}${note ? `: ${note}` : ''}`);
  await job.save();
  await AuditLog.create({ businessId, branchId: job.branchId, userId, action: 'jobcard.approval', entityType: 'JobCard', entityId: job._id, newValue: { channel, total: job.total } });
  return job;
}

async function issuePart(businessId, userId, id, partId) {
  return inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (!APPROVED_STATES.includes(job.status)) throw ApiError.conflict('Parts can only be issued once the estimate is approved', 'INVALID_JOBCARD_STATE');
    const part = job.parts.id(partId);
    if (!part) throw ApiError.badRequest('Part line not found', 'PART_NOT_FOUND');
    if (part.issued) throw ApiError.conflict('This part has already been issued', 'PART_ALREADY_ISSUED');
    const product = await Product.findOne({ _id: part.productId, businessId }).session(session);
    if (!product) throw ApiError.notFound('Part product not found');
    if (product.trackInventory) {
      await applyStockChange({
        businessId, branchId: job.branchId, productId: part.productId, variantId: part.variantId || null, quantityDelta: -part.quantity,
        type: 'ADJUSTMENT_OUT', referenceType: 'JobCard', referenceId: job._id, reason: `Job card ${job.jobNumber}: part issued`, performedBy: userId, session,
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

async function returnPart(businessId, userId, id, partId) {
  return inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (['READY', 'COLLECTED', 'QUALITY_CHECK'].includes(job.status)) throw ApiError.conflict('Parts cannot be returned once work is finished', 'INVALID_JOBCARD_STATE');
    const part = job.parts.id(partId);
    if (!part) throw ApiError.badRequest('Part line not found', 'PART_NOT_FOUND');
    if (!part.issued) throw ApiError.conflict('This part was never issued', 'PART_NOT_ISSUED');
    const product = await Product.findOne({ _id: part.productId, businessId }).session(session);
    if (product?.trackInventory) {
      await applyStockChange({
        businessId, branchId: job.branchId, productId: part.productId, variantId: part.variantId || null, quantityDelta: part.quantity,
        type: 'RETURN', referenceType: 'JobCard', referenceId: job._id, reason: `Job card ${job.jobNumber}: unused part returned`, performedBy: userId, session, allowNegative: true,
      });
    }
    if (part.batchAllocations?.length) {
      const notSellable = await batchService.restoreAllocations(businessId, { batchAllocations: part.batchAllocations, quantity: part.quantity }, session);
      if (notSellable > 0 && product?.trackInventory) {
        await applyStockChange({
          businessId, branchId: job.branchId, productId: part.productId, variantId: part.variantId || null, quantityDelta: -notSellable,
          type: 'ADJUSTMENT_OUT', referenceType: 'JobCard', referenceId: job._id, reason: `Job card ${job.jobNumber}: returned part belongs to a held or expired batch`, performedBy: userId, session, allowNegative: true,
        });
      }
    }
    part.deleteOne();
    recalc(job);
    if (!job.isWarrantyRepair && APPROVED_STATES.includes(job.status) && job.total < job.approvedTotal) job.approvedTotal = job.total; // a lower bill never needs re-approval
    await job.save({ session });
    return job;
  });
}

/** Mechanic ticks a labour line as done (only on approved work). */
async function markLabourDone(businessId, userId, id, labourId, done = true) {
  const job = await load(businessId, id);
  if (!['IN_PROGRESS', 'APPROVED'].includes(job.status)) throw ApiError.conflict('Labour can only be ticked off while work is in progress', 'INVALID_JOBCARD_STATE');
  const l = job.labourLines.id(labourId);
  if (!l) throw ApiError.badRequest('Labour line not found', 'LABOUR_NOT_FOUND');
  l.done = !!done; l.doneAt = done ? new Date() : undefined;
  if (job.status === 'APPROVED') { job.status = 'IN_PROGRESS'; log(job, 'IN_PROGRESS', userId, `Work started: ${l.description}`); }
  await job.save();
  return job;
}

const TRANSITIONS = {
  startWork: { from: ['APPROVED', 'AWAITING_PARTS'], to: 'IN_PROGRESS' },
  awaitParts: { from: ['APPROVED', 'IN_PROGRESS'], to: 'AWAITING_PARTS' },
  sendToQualityCheck: { from: ['IN_PROGRESS'], to: 'QUALITY_CHECK' },
};

async function transition(businessId, userId, id, action, note) {
  const t = TRANSITIONS[action];
  if (!t) throw ApiError.badRequest('Unknown action', 'INVALID_ACTION');
  const job = await load(businessId, id);
  if (!t.from.includes(job.status)) throw ApiError.conflict(`Cannot do "${action}" while the job card is ${job.status}`, 'INVALID_JOBCARD_STATE');
  if (action === 'sendToQualityCheck') {
    if (!job.parts.every((p) => p.issued)) throw ApiError.badRequest('Issue all parts on the estimate (or remove them) first', 'PARTS_NOT_ISSUED');
    if (!job.labourLines.every((l) => l.done)) throw ApiError.badRequest('Tick off all labour lines (or remove them) first', 'LABOUR_NOT_DONE');
  }
  job.status = t.to; log(job, t.to, userId, note);
  await job.save();
  await AuditLog.create({ businessId, branchId: job.branchId, userId, action: `jobcard.${action}`, entityType: 'JobCard', entityId: job._id, newValue: { note } });
  return job;
}

/** Final inspection. Pass -> READY. Fail -> back to IN_PROGRESS (the failed labour must be re-opened by the mechanic). The checker cannot be the mechanic who did the work, unless a manager. */
async function qualityCheck(businessId, user, id, { passed, note, roadTest = false }) {
  const job = await load(businessId, id);
  if (job.status !== 'QUALITY_CHECK') throw ApiError.conflict(`Job card is ${job.status}, not in quality check`, 'INVALID_JOBCARD_STATE');
  const didWork = job.labourLines.some((l) => String(l.mechanicId) === String(user._id)) || String(job.mechanicId) === String(user._id);
  if (didWork && !hasPermission(user, 'jobcards.approve')) throw ApiError.forbidden('Someone other than the mechanic must do the final check', 'SELF_QC');
  if (!passed && !note) throw ApiError.badRequest('Say what failed the check', 'REASON_REQUIRED');
  job.qualityCheck = { passed: !!passed, by: user._id, at: new Date(), note, roadTest: !!roadTest };
  job.status = passed ? 'READY' : 'IN_PROGRESS';
  if (!passed) job.labourLines.forEach((l) => { l.done = false; l.doneAt = undefined; });
  log(job, job.status, user._id, passed ? `Quality check passed${roadTest ? ' (road tested)' : ''}${note ? `: ${note}` : ''}` : `Quality check FAILED: ${note}`);
  await job.save();
  await AuditLog.create({ businessId, branchId: job.branchId, userId: user._id, action: 'jobcard.qc', entityType: 'JobCard', entityId: job._id, newValue: { passed: !!passed, roadTest: !!roadTest } });
  if (passed) require('./sms/alerts.service').onReady('jobcard', job).catch(() => {}); // text the customer; never blocks the workflow
  return job;
}

async function cancelJob(businessId, userId, id, { reason }) {
  const job = await load(businessId, id);
  if (['COLLECTED', 'CANCELLED'].includes(job.status)) throw ApiError.conflict(`Job card is already ${job.status}`, 'INVALID_JOBCARD_STATE');
  if (job.parts.some((p) => p.issued)) throw ApiError.conflict('Return the issued parts to stock before cancelling', 'PARTS_ISSUED');
  job.status = 'CANCELLED'; job.cancelReason = reason; log(job, 'CANCELLED', userId, reason);
  await job.save();
  await AuditLog.create({ businessId, branchId: job.branchId, userId, action: 'jobcard.cancel', entityType: 'JobCard', entityId: job._id, newValue: { reason } });
  return job;
}

/**
 * Deposits / payments / refunds. Each is a real Payment record (payments report, cash shift, drawer count).
 * Same rules as repairs: CASH needs an open shift when required; MPESA must be a confirmed unused transaction for
 * exactly this amount; REFUND needs jobcards.approve and cannot exceed what was paid. Deposits are not revenue until collection.
 */
async function recordPayment(businessId, user, id, { type, method, amount, reference }) {
  return inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (job.status === 'COLLECTED') throw ApiError.conflict('This job card is closed. The vehicle was collected and invoiced.', 'INVALID_JOBCARD_STATE');
    if (job.status === 'CANCELLED' && type !== 'REFUND') throw ApiError.conflict('Job card is cancelled', 'INVALID_JOBCARD_STATE');
    if (job.isWarrantyRepair && type !== 'REFUND') throw ApiError.badRequest('Warranty comebacks are free: there is nothing to pay', 'WARRANTY_REPAIR');

    if (type === 'REFUND') {
      if (!hasPermission(user, 'jobcards.approve')) throw ApiError.forbidden('Only a manager can refund a job card payment', 'FORBIDDEN');
      if (amount > job.paid) throw ApiError.badRequest('Refund is more than was paid', 'REFUND_EXCEEDS_PAID');
    } else if (job.total > 0 && amount > job.balance && job.status !== 'CHECKED_IN') {
      throw ApiError.badRequest('Payment is more than the balance owing', 'OVERPAYMENT');
    }

    const business = await Business.findById(businessId).select('settings').session(session);
    const shift = await CashShift.findOne({ businessId, branchId: job.branchId, cashierId: user._id, status: 'OPEN' }).session(session);
    if (method === 'CASH' && business?.settings?.requireShift && !shift) throw ApiError.badRequest('Open a cash shift before taking cash payments', 'SHIFT_REQUIRED');

    let provider = 'manual'; let externalTransactionId; let verified = false; let metadata;
    if (method === 'MPESA' && type !== 'REFUND') {
      if (!reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED');
      const confirmed = await mpesaService.consumeForJobCard(businessId, reference, amount, job._id, session);
      provider = confirmed.channel === 'MANUAL' ? 'payhero-till' : 'payhero';
      externalTransactionId = confirmed.externalTransactionId; verified = true;
      metadata = { checkoutRequestId: confirmed.checkoutRequestId, channel: confirmed.channel };
    }

    const [payment] = await Payment.create([{
      businessId, branchId: job.branchId, jobCardId: job._id, customerId: job.customerId, shiftId: shift?._id,
      method, provider, amount, reference, externalTransactionId, metadata,
      initiatedBy: user._id, status: type === 'REFUND' ? 'REFUNDED' : 'SUCCESS', completedAt: new Date(),
      ...(method === 'CASH' && type !== 'REFUND' ? { amountTendered: amount, changeGiven: 0 } : {}),
    }], { session });

    job.payments.push({ type, method, amount, reference, by: user._id, verified, paymentId: payment._id });
    recalc(job);
    await job.save({ session });
    await AuditLog.create([{ businessId, branchId: job.branchId, userId: user._id, action: 'jobcard.payment', entityType: 'JobCard', entityId: job._id, newValue: { type, method, amount, reference, paymentId: payment._id } }], { session });
    return job;
  });
}

async function ensureLabourProduct(businessId, taxRate, session) {
  let product = await Product.findOne({ businessId, sku: LABOUR_SKU }).session(session);
  if (!product) {
    [product] = await Product.create([{
      businessId, name: 'Garage labour', sku: LABOUR_SKU, productType: 'service', unit: 'service',
      trackInventory: false, costPrice: 0, sellingPrice: 0, taxRate, status: 'active',
    }], { session });
  }
  return product;
}

/** Invoice for a collected job card: a real Sale (source GARAGE). No stock moves here: parts were issued on the job. */
async function createSettlementSale({ business, job, user, session }) {
  const { businessId } = job;
  const branch = await Branch.findById(job.branchId).session(session);
  const labourProduct = job.labourLines.length ? await ensureLabourProduct(businessId, job.labourTaxRate || 0, session) : null;
  const partProducts = await Product.find({ businessId, _id: { $in: job.parts.map((p) => p.productId) } }).session(session);
  const productById = new Map(partProducts.map((p) => [String(p._id), p]));

  const lines = jobLines(job);
  const items = lines.map((l) => {
    if (l.kind === 'LABOUR') {
      return {
        productId: labourProduct._id, nameSnapshot: l.labour.description, skuSnapshot: LABOUR_SKU, quantity: 1, unitPrice: l.unitPrice,
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
    throw ApiError.conflict('The job total, payments and waived amount do not add up. Please contact support before collecting.', 'JOBCARD_TOTALS_MISMATCH');
  }

  const rSeq = await nextSequence(businessId, `receipt:branch:${job.branchId}`, session);
  const receiptNumber = `${business.receiptSettings?.receiptPrefix || 'RCT'}-${branch?.code || 'MAIN'}-${pad(rSeq)}`;
  const iSeq = await nextSequence(businessId, `invoice:branch:${job.branchId}`, session);
  const invoiceNumber = `${business.receiptSettings?.invoicePrefix || 'INV'}-${branch?.code || 'MAIN'}-${pad(iSeq)}`;
  const now = new Date();

  const [sale] = await Sale.create([{
    businessId, branchId: job.branchId, receiptNumber, invoiceNumber, customerId: job.customerId, cashierId: user._id,
    items, subtotal: totals.subtotal, itemDiscount: 0, cartDiscount: job.waived || 0, tax: totals.tax, total: totals.total,
    amountPaid: job.paid, balance: 0, paymentStatus: 'PAID', saleStatus: 'COMPLETED', source: 'GARAGE', jobCardId: job._id,
    notes: `Job card ${job.jobNumber} · ${job.plate}${job.waived ? ` (balance waived: ${job.waiveReason})` : ''}`, soldAt: now,
  }], { session });

  await Payment.updateMany({ businessId, jobCardId: job._id }, { $set: { saleId: sale._id } }, { session });

  const rs = business.receiptSettings || {};
  await Receipt.create([{
    businessId, branchId: job.branchId, saleId: sale._id, receiptNumber, invoiceNumber, soldAt: now,
    receiptData: {
      business: {
        name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin,
        footerMessage: rs.footerMessage, headerMessage: rs.headerMessage, logo: rs.showLogo ? business.logo : undefined,
        showKraPin: rs.showKraPin ?? true, showCashierName: rs.showCashierName ?? true, showMpesaReceiptCode: rs.showMpesaReceiptCode ?? true,
        customLines: [...(rs.customLines || []), `Job card ${job.jobNumber} · ${job.plate}`, ...(job.workWarrantyDays ? [`Work guaranteed for ${job.workWarrantyDays} days`] : [])], paperWidth: rs.paperWidth || '80mm',
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

  await AuditLog.create([{ businessId, branchId: job.branchId, userId: user._id, action: 'sale.create', entityType: 'Sale', entityId: sale._id, newValue: { receiptNumber, total: totals.total, source: 'GARAGE', jobNumber: job.jobNumber } }], { session });
  await etimsService.enqueueForSale(businessId, job.branchId, sale._id, { session });
  return sale;
}

/**
 * Hand the vehicle back. Needs a passed quality check (card is READY), an exit odometer, and the balance settled
 * (or waived by a manager with a reason). Creates the invoice, records the work warranty, and updates the vehicle's
 * odometer, last service and next service due.
 */
async function collect(businessId, user, id, { collectedByName, idChecked = false, odometerOut, workWarrantyDays = 0, nextServiceKm, nextServiceDate, waiveBalance = false, waiveReason }) {
  const job = await inTx(async (session) => {
    const job = await load(businessId, id, session);
    if (job.status !== 'READY') throw ApiError.conflict(`Job card is ${job.status}, not READY`, 'INVALID_JOBCARD_STATE');
    if (odometerOut < job.odometerIn) throw ApiError.badRequest(`Exit odometer is lower than the check-in reading (${job.odometerIn} km)`, 'ODOMETER_BACKWARDS');
    recalc(job);
    if (job.balance < 0) throw ApiError.conflict('The customer has overpaid. Record a refund first.', 'OVERPAID');
    if (job.balance > 0) {
      if (!waiveBalance) throw ApiError.conflict(`Balance of ${job.balance} cents is still owing`, 'BALANCE_OWING');
      if (!hasPermission(user, 'jobcards.approve')) throw ApiError.forbidden('Only a manager can waive a balance', 'FORBIDDEN');
      if (!waiveReason) throw ApiError.badRequest('A reason is required to waive the balance', 'REASON_REQUIRED');
      job.waived = job.balance; job.waiveReason = waiveReason;
      recalc(job);
    }
    if (job.total > 0) {
      const business = await Business.findById(businessId).session(session);
      const sale = await createSettlementSale({ business, job, user, session });
      job.settlementSaleId = sale._id;
    }

    const now = new Date();
    job.status = 'COLLECTED'; job.collectedAt = now; job.collectedBy = user._id; job.collectedByName = collectedByName; job.collectorIdChecked = idChecked;
    job.odometerOut = odometerOut; job.workWarrantyDays = workWarrantyDays;
    job.workWarrantyUntil = workWarrantyDays > 0 ? new Date(now.getTime() + workWarrantyDays * 86400000) : undefined;
    job.nextServiceKm = nextServiceKm; job.nextServiceDate = nextServiceDate;
    log(job, 'COLLECTED', user._id, `Collected by ${collectedByName}`);
    await job.save({ session });

    const v = await Vehicle.findOne({ _id: job.vehicleId, businessId }).session(session);
    if (v) {
      if (odometerOut > v.odometerKm) v.odometerKm = odometerOut;
      v.lastServiceAt = now; v.lastServiceKm = odometerOut;
      v.nextServiceKm = nextServiceKm ?? undefined; v.nextServiceDate = nextServiceDate ?? undefined;
      await v.save({ session });
    }
    await AuditLog.create([{ businessId, branchId: job.branchId, userId: user._id, action: 'jobcard.collect', entityType: 'JobCard', entityId: job._id, newValue: { collectedByName, idChecked, odometerOut, waived: job.waived, saleId: job.settlementSaleId } }], { session });
    return job;
  });

  if (job.settlementSaleId) {
    try { require('./crm.service').onSaleCompleted(businessId, job.settlementSaleId); } catch (e) { console.error('[crm] capture hook failed', e.message); }
    etimsService.kickForSale(businessId, job.settlementSaleId);
  }
  return job;
}

/** Garage money picture: deposits held (liability) vs invoiced revenue, plus labour hours billed per mechanic. */
async function summary(businessId, { from, to, branchId }) {
  const oid = (v) => new mongoose.Types.ObjectId(String(v));
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400000);
  const base = { businessId: oid(businessId) };
  if (branchId) base.branchId = oid(branchId);

  const [byStatus, open, revenue, mechanics] = await Promise.all([
    JobCard.aggregate([{ $match: { ...base, createdAt: { $gte: start, $lte: end } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    JobCard.aggregate([
      { $match: { ...base, status: { $nin: ['COLLECTED', 'CANCELLED'] } } },
      { $group: { _id: null, jobs: { $sum: 1 }, depositsHeld: { $sum: '$paid' }, estimatedTotal: { $sum: '$total' } } },
    ]),
    Sale.aggregate([
      { $match: { ...base, source: 'GARAGE', saleStatus: 'COMPLETED', soldAt: { $gte: start, $lte: end } } },
      { $unwind: '$items' },
      { $group: {
        _id: null, sales: { $addToSet: '$_id' }, revenue: { $sum: '$items.total' }, tax: { $sum: '$items.taxAmount' },
        labour: { $sum: { $cond: [{ $eq: ['$items.skuSnapshot', LABOUR_SKU] }, '$items.total', 0] } },
        partsCost: { $sum: { $multiply: ['$items.costPriceSnapshot', '$items.quantity'] } },
      } },
    ]),
    JobCard.aggregate([
      { $match: { ...base, status: 'COLLECTED', collectedAt: { $gte: start, $lte: end }, isWarrantyRepair: false } },
      { $unwind: '$labourLines' },
      { $group: { _id: { $ifNull: ['$labourLines.mechanicId', '$mechanicId'] }, hours: { $sum: '$labourLines.hours' }, labourValue: { $sum: { $round: [{ $multiply: ['$labourLines.hours', '$labourLines.rate'] }, 0] } }, jobs: { $addToSet: '$_id' } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $project: { _id: 0, mechanicId: '$_id', name: { $arrayElemAt: ['$u.name', 0] }, hours: 1, labourValue: 1, jobs: { $size: '$jobs' } } },
      { $sort: { labourValue: -1 } },
    ]),
  ]);
  const r = revenue[0] || { sales: [], revenue: 0, tax: 0, labour: 0, partsCost: 0 };
  const o = open[0] || { jobs: 0, depositsHeld: 0, estimatedTotal: 0 };
  const cents = (n) => Math.round(n) / 100;
  return {
    from: start, to: end,
    jobCardsCreatedByStatus: Object.fromEntries(byStatus.map((x) => [x._id, x.count])),
    openJobCards: o.jobs, depositsHeld: cents(o.depositsHeld), openJobCardsEstimatedValue: cents(o.estimatedTotal),
    invoices: r.sales.length, revenue: cents(r.revenue), labourRevenue: cents(r.labour), partsRevenue: cents(r.revenue - r.labour),
    partsCost: cents(r.partsCost), grossProfit: cents(r.revenue - r.tax - r.partsCost), taxCollected: cents(r.tax),
    mechanics: mechanics.map((m) => ({ ...m, labourValue: cents(m.labourValue) })),
  };
}

async function listJobs(businessId, { branchId, status, vehicleId, mechanicId, search, overdue, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (status) filter.status = status;
  if (vehicleId) filter.vehicleId = vehicleId;
  if (mechanicId) filter.$or = [{ mechanicId }, { 'labourLines.mechanicId': mechanicId }];
  if (overdue) { filter.promisedDate = { $lt: new Date() }; filter.status = { $in: EDITABLE.concat('QUALITY_CHECK') }; }
  if (search) {
    const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const sf = [{ jobNumber: re }, { customerName: re }, { customerPhone: re }, { plate: re }, { vehicleLabel: re }];
    filter.$and = [{ $or: sf }];
  }
  const [items, total] = await Promise.all([
    JobCard.find(filter).select('-history -payments -parts -labourLines').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    JobCard.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/** Vehicles ready but not collected for `days` days (they take up yard space and accrue risk). */
async function uncollected(businessId, { days = 7, branchId }) {
  const filter = { businessId, status: 'READY', updatedAt: { $lte: new Date(Date.now() - days * 86400000) } };
  if (branchId) filter.branchId = branchId;
  return JobCard.find(filter).select('jobNumber plate vehicleLabel customerName customerPhone updatedAt balance total').sort({ updatedAt: 1 }).limit(500);
}

const getJob = (businessId, id) => load(businessId, id);

/** Staff pressed "send the ready SMS again" (at most once an hour per card). */
async function notifyReady(businessId, id) {
  const job = await load(businessId, id);
  if (job.status !== 'READY') throw ApiError.conflict('The customer can only be notified once the vehicle is READY', 'INVALID_JOBCARD_STATE');
  return require('./sms/alerts.service').onReady('jobcard', job, { businessId, manual: true });
}

module.exports = {
  notifyReady, createJob, updateEstimate, recordApproval, issuePart, returnPart, markLabourDone, transition, qualityCheck, cancelJob,
  recordPayment, collect, summary, listJobs, uncollected, getJob, recalc, jobLines,
};