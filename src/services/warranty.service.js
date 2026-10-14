const mongoose = require('mongoose');
const WarrantyClaim = require('../models/WarrantyClaim');
const SerialNumber = require('../models/SerialNumber');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { normalizeSerial } = require('../utils/imei');
const { applyStockChange } = require('./inventory.service');
const { event } = require('./serial.service');
const repairService = require('./repair.service');

async function inTx(fn) {
  const session = await mongoose.startSession();
  try { let out; await session.withTransaction(async () => { out = await fn(session); }); return out; } finally { session.endSession(); }
}

/**
 * Open a claim. Eligibility is worked out from the unit's own record: it must have been sold, and the claim is
 * marked SHOP (inside warranty) or EXPIRED. Claims are recorded either way; an expired claim can only be
 * approved as goodwill by someone with decide permission.
 */
async function createClaim(businessId, branchId, userId, { serialNumber, fault }) {
  return inTx(async (session) => {
    const unit = await SerialNumber.findOne({ businessId, serialNumber: normalizeSerial(serialNumber) }).session(session);
    if (!unit) throw ApiError.notFound('No unit with that serial number / IMEI was sold by this business', 'SERIAL_NOT_FOUND');
    if (unit.status !== 'sold') throw ApiError.conflict(`This unit is ${unit.status}, not with a customer, so it cannot have a warranty claim`, 'UNIT_NOT_SOLD');

    const open = await WarrantyClaim.findOne({ businessId, serialId: unit._id, status: { $in: ['OPEN', 'APPROVED'] } }).select('claimNumber').session(session);
    if (open) throw ApiError.conflict(`There is already an open claim for this unit (${open.claimNumber})`, 'CLAIM_ALREADY_OPEN');

    const now = new Date();
    const coverage = unit.warrantyEnd && unit.warrantyEnd >= now ? 'SHOP' : 'EXPIRED';
    const [product, customer] = await Promise.all([
      Product.findOne({ _id: unit.productId, businessId }).select('name').session(session),
      unit.customerId ? Customer.findOne({ _id: unit.customerId, businessId }).select('name phone').session(session) : null,
    ]);
    const seq = await nextSequence(businessId, 'warranty:business', session);
    const [claim] = await WarrantyClaim.create([{
      businessId, branchId, claimNumber: `WC-${pad(seq)}`, serialId: unit._id, serialNumber: unit.serialNumber, productId: unit.productId,
      nameSnapshot: product?.name, saleId: unit.saleId, customerId: unit.customerId, customerName: customer?.name, customerPhone: customer?.phone,
      fault, coverage, warrantyEndAtClaim: unit.warrantyEnd, createdBy: userId,
    }], { session });
    unit.history.push(event('WARRANTY_CLAIM', { by: userId, refType: 'WarrantyClaim', refId: claim._id, note: coverage }));
    await unit.save({ session });
    await AuditLog.create([{ businessId, branchId, userId, action: 'warranty.claim', entityType: 'WarrantyClaim', entityId: claim._id, newValue: { serial: unit.serialNumber, coverage } }], { session });
    return claim;
  });
}

/**
 * Decide a claim: REPAIR (opens a free repair job), REPLACEMENT (a specific in-stock unit of the same product
 * is handed over, and the faulty unit is written off as damaged, to go back to the supplier) or REJECT.
 * Out-of-warranty approval needs goodwill=true plus a reason.
 */
async function decideClaim(businessId, user, id, { decision, reason, goodwill = false, replacementSerialNumber, technicianId, promisedDate }) {
  return inTx(async (session) => {
    const claim = await WarrantyClaim.findOne({ _id: id, businessId }).session(session);
    if (!claim) throw ApiError.notFound('Warranty claim not found');
    if (claim.status !== 'OPEN') throw ApiError.conflict(`Claim is ${claim.status}`, 'INVALID_CLAIM_STATE');
    if (!reason || reason.trim().length < 3) throw ApiError.badRequest('A reason is required', 'REASON_REQUIRED');

    claim.decision = decision; claim.decisionReason = reason; claim.decidedBy = user._id; claim.decidedAt = new Date();

    if (decision === 'REJECT') {
      claim.status = 'REJECTED';
    } else {
      if (claim.coverage === 'EXPIRED') {
        if (!goodwill) throw ApiError.badRequest('The warranty has expired. Approve as goodwill (goodwill: true) or reject the claim.', 'WARRANTY_EXPIRED');
        claim.goodwill = true;
      }
      const unit = await SerialNumber.findOne({ _id: claim.serialId, businessId }).session(session);
      if (!unit || unit.status !== 'sold') throw ApiError.conflict('The unit is no longer recorded as sold', 'INVALID_SERIAL_STATE');

      if (decision === 'REPAIR') {
        const job = await repairService.createJob(businessId, claim.branchId, user._id, {
          customerId: claim.customerId, customerName: claim.customerName, customerPhone: claim.customerPhone,
          device: { serialNumber: claim.serialNumber, model: claim.nameSnapshot }, fault: claim.fault,
          technicianId, promisedDate, isWarrantyRepair: true, warrantyClaimId: claim._id,
        }, session);
        claim.repairJobId = job._id; claim.status = 'APPROVED';
      } else {
        if (!replacementSerialNumber) throw ApiError.badRequest('Give the serial number of the replacement unit', 'REPLACEMENT_REQUIRED');
        const repSn = normalizeSerial(replacementSerialNumber);
        const now = new Date();
        // The replacement keeps the ORIGINAL warranty end if it was still running; otherwise (goodwill) it has none.
        const keepEnd = claim.coverage === 'SHOP' ? unit.warrantyEnd : undefined;
        const rep = await SerialNumber.findOneAndUpdate(
          { businessId, serialNumber: repSn, productId: unit.productId, branchId: claim.branchId, status: 'in_stock' },
          { $set: { status: 'sold', customerId: unit.customerId, soldAt: now, warrantyStart: keepEnd ? now : undefined, warrantyEnd: keepEnd },
            $push: { history: event('REPLACEMENT_FOR', { by: user._id, refType: 'WarrantyClaim', refId: claim._id, note: `replaces ${unit.serialNumber}` }) } },
          { session, new: true }
        );
        if (!rep) throw ApiError.badRequest(`Replacement ${repSn} must be an in-stock unit of the same product at this branch`, 'REPLACEMENT_NOT_AVAILABLE');
        const product = await Product.findOne({ _id: unit.productId, businessId }).session(session);
        if (product?.trackInventory) {
          await applyStockChange({
            businessId, branchId: claim.branchId, productId: unit.productId, variantId: unit.variantId || null, quantityDelta: -1,
            type: 'ADJUSTMENT_OUT', referenceType: 'WarrantyClaim', referenceId: claim._id,
            reason: `Warranty replacement ${claim.claimNumber}: ${repSn} replaces ${unit.serialNumber}`, performedBy: user._id, session, allowNegative: true,
          });
        }
        unit.status = 'damaged';
        unit.history.push(event('REPLACED_BY', { by: user._id, refType: 'WarrantyClaim', refId: claim._id, note: `replaced by ${repSn}` }));
        await unit.save({ session });
        claim.replacementSerialId = rep._id; claim.replacementSerialNumber = repSn;
        claim.status = 'RESOLVED'; claim.resolvedAt = now;
      }
    }
    await claim.save({ session });
    await AuditLog.create([{ businessId, branchId: claim.branchId, userId: user._id, action: 'warranty.decide', entityType: 'WarrantyClaim', entityId: claim._id, newValue: { decision, goodwill, reason } }], { session });
    return claim;
  });
}

/** Track sending the faulty unit to the supplier under the supplier's warranty. */
async function recordSupplierRma(businessId, userId, id, { reference, sentAt, outcome = 'PENDING', note }) {
  const claim = await WarrantyClaim.findOne({ _id: id, businessId });
  if (!claim) throw ApiError.notFound('Warranty claim not found');
  if (claim.status === 'OPEN' || claim.status === 'REJECTED') throw ApiError.conflict('Decide the customer claim first', 'INVALID_CLAIM_STATE');
  const unit = await SerialNumber.findOne({ _id: claim.serialId, businessId }).select('supplierWarrantyEnd');
  const sent = sentAt || new Date();
  if (unit?.supplierWarrantyEnd && unit.supplierWarrantyEnd < sent && !note) {
    throw ApiError.badRequest("The supplier's warranty has expired. Add a note if you are claiming anyway.", 'SUPPLIER_WARRANTY_EXPIRED');
  }
  claim.supplierRma = { reference, sentAt: sent, outcome, note };
  await claim.save();
  await AuditLog.create({ businessId, branchId: claim.branchId, userId, action: 'warranty.supplier_rma', entityType: 'WarrantyClaim', entityId: claim._id, newValue: { reference, outcome } });
  return claim;
}

async function listClaims(businessId, { branchId, status, serialNumber, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (status) filter.status = status;
  if (serialNumber) filter.serialNumber = normalizeSerial(serialNumber);
  const [items, total] = await Promise.all([
    WarrantyClaim.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    WarrantyClaim.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getClaim(businessId, id) {
  const claim = await WarrantyClaim.findOne({ _id: id, businessId });
  if (!claim) throw ApiError.notFound('Warranty claim not found');
  return claim;
}

module.exports = { createClaim, decideClaim, recordSupplierRma, listClaims, getClaim };