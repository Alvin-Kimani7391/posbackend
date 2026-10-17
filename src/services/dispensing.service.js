/** Reading, labelling and reversing dispensings. Creating one happens inside the sale (pharmacy-guard.recordWithinSale). */
const DispensingRecord = require('../models/DispensingRecord');
const Prescription = require('../models/Prescription');
const Sale = require('../models/Sale');
const Business = require('../models/Business');
const Patient = require('../models/Patient');
const AuditLog = require('../models/AuditLog');
const refundService = require('./refund.service');
const patients = require('./patient.service');
const guard = require('./pharmacy-guard.service');
const ApiError = require('../utils/ApiError');

async function load(businessId, id) {
  const r = await DispensingRecord.findOne({ _id: id, businessId });
  if (!r) throw ApiError.notFound('Dispensing record not found');
  return r;
}

async function get(businessId, user, id) {
  const r = await load(businessId, id);
  await patients.logRead(businessId, user, [r.patientId], `dispensing ${r.number}`);
  return r;
}

async function list(businessId, user, { patientId, prescriptionId, dispenserId, status, from, to, page = 1, limit = 20 } = {}) {
  const filter = { businessId };
  if (patientId) filter.patientId = patientId; if (prescriptionId) filter.prescriptionId = prescriptionId;
  if (dispenserId) filter.dispenserId = dispenserId; if (status) filter.status = status;
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [rows, total] = await Promise.all([DispensingRecord.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), DispensingRecord.countDocuments(filter)]);
  if (patientId) await patients.logRead(businessId, user, [patientId], 'dispensing list');
  return { dispensings: rows, total, page, limit };
}

/** Label data. The first print is free; every reprint needs a reason and is recorded. */
async function label(businessId, user, id, { reason } = {}) {
  const r = await load(businessId, id);
  if (r.status !== 'DISPENSED') throw ApiError.conflict('This dispensing was reversed. No label can be printed.', 'DISPENSING_REVERSED');
  const first = r.labelPrints.length === 0;
  if (!first && !reason) throw ApiError.badRequest('A reason is required to reprint a label', 'REASON_REQUIRED');
  r.labelPrints.push({ at: new Date(), by: user._id, reason: first ? 'INITIAL' : reason });
  await r.save();
  await AuditLog.create({ businessId, branchId: r.branchId, userId: user._id, action: 'dispensing.label', entityType: 'DispensingRecord', entityId: r._id, newValue: { first, reason } });
  const [patient, business] = await Promise.all([Patient.findOne({ _id: r.patientId, businessId }), Business.findById(businessId).select('name address phone')]);
  await patients.logRead(businessId, user, [r.patientId], `label ${r.number}`);
  return {
    pharmacy: { name: business?.name, address: business?.address, phone: business?.phone }, dispensingNumber: r.number, date: r.createdAt,
    patientName: patient?.name, dispensedBy: r.dispenserSnapshot,
    labels: r.items.map((i) => ({
      medicine: i.nameSnapshot, strength: i.strength, dosageForm: i.dosageForm, quantity: i.quantity, directions: i.directions,
      batches: (i.batchAllocations || []).map((b) => ({ batchNumber: b.batchNumber, expiryDate: b.expiryDate })),
    })),
    reprint: !first,
  };
}

/**
 * Correct a dispensing: it is REVERSED, never edited. The money goes back through the normal refund flow and the
 * medicine goes into QUARANTINE (never straight back on the shelf). The prescription gets its quantity back.
 */
async function reverse(businessId, user, id, { reason, refundMethod = 'CASH' }) {
  const r = await load(businessId, id);
  if (r.status !== 'DISPENSED') throw ApiError.conflict('This dispensing is already reversed', 'ALREADY_REVERSED');
  const business = await Business.findById(businessId).select('settings');
  const canComplete = ['OWNER', 'ADMIN', 'MANAGER'].includes(user.role);
  if (business?.settings?.requireManagerRefundApproval && !canComplete) throw ApiError.forbidden('A manager must carry out this reversal because refunds need manager approval', 'MANAGER_REQUIRED');

  const sale = await Sale.findOne({ _id: r.saleId, businessId });
  if (!sale) throw ApiError.notFound('Sale not found');
  const items = r.items.map((i) => {
    const line = sale.items.find((si) => String(si.productId) === String(i.productId));
    if (!line) throw ApiError.conflict('The sale no longer matches this dispensing', 'SALE_MISMATCH');
    const left = line.quantity - (line.refundedQuantity || 0);
    if (left < (i.quantity / (line.unitFactor || 1)) - 1e-9) throw ApiError.conflict(`${i.nameSnapshot} has already been partly refunded`, 'ALREADY_REFUNDED');
    return { productId: line.productId, variantId: line.variantId ? String(line.variantId) : undefined, quantity: i.quantity / (line.unitFactor || 1), disposition: 'QUARANTINE' };
  });
  const out = await refundService.requestRefund(businessId, sale.branchId, user, { saleId: sale._id, items, reason: `Dispensing ${r.number} reversed: ${reason}`, paymentMethod: refundMethod }, { dispensingReversal: true });
  const refund = out.refund || out;

  r.status = 'REVERSED'; r.reversal = { by: user._id, at: new Date(), reason, refundId: refund._id };
  await r.save();
  const rx = await Prescription.findOne({ _id: r.prescriptionId, businessId });
  if (rx) {
    for (const i of r.items) { const pi = rx.items.find((x) => String(x.productId) === String(i.productId)); if (pi) pi.dispensedQty = Math.max(0, Math.round(((pi.dispensedQty || 0) - i.quantity) * 1000) / 1000); }
    if (['DISPENSED', 'PARTIALLY_DISPENSED'].includes(rx.status)) rx.status = rx.items.some((x) => x.dispensedQty > 0) ? 'PARTIALLY_DISPENSED' : 'VALIDATED';
    if (rx.validUntil < new Date() && ['VALIDATED', 'PARTIALLY_DISPENSED'].includes(rx.status)) rx.status = 'EXPIRED';
    await rx.save();
  }
  await AuditLog.create({ businessId, branchId: r.branchId, userId: user._id, action: 'dispensing.reverse', entityType: 'DispensingRecord', entityId: r._id, newValue: { reason, refundId: refund._id } });
  return { dispensing: r, refund };
}

module.exports = { get, list, label, reverse };