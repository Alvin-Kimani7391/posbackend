/**
 * Supplier approval and returns. A pharmacy buys medicines only from suppliers whose licence is on file and current, and
 * can send stock back to the supplier traced to its batch (a returned recalled batch resolves that recall).
 */
const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const SupplierReturn = require('../models/SupplierReturn');
const MedicineDetails = require('../models/MedicineDetails');
const Batch = require('../models/Batch');
const Product = require('../models/Product');
const AuditLog = require('../models/AuditLog');
const batchService = require('./batch.service');
const { applyStockChange } = require('./inventory.service');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');

async function inTx(fn) {
  const session = await mongoose.startSession();
  try { let out; await session.withTransaction(async () => { out = await fn(session); }); return out; } finally { session.endSession(); }
}

const approvalState = (s) => {
  const a = s.pharmacyApproval;
  if (!a || !a.approved) return 'NOT_APPROVED';
  if (a.licenseExpiry && new Date(a.licenseExpiry) < new Date()) return 'LICENCE_EXPIRED';
  return 'APPROVED';
};

async function setApproval(businessId, user, supplierId, { licenseNumber, licenseExpiry, note }) {
  if (licenseExpiry && new Date(licenseExpiry) < new Date()) throw ApiError.badRequest('That licence has already expired', 'LICENCE_EXPIRED');
  const s = await Supplier.findOneAndUpdate({ _id: supplierId, businessId }, { $set: { pharmacyApproval: { approved: true, licenseNumber, licenseExpiry, approvedBy: user._id, approvedAt: new Date(), note } } }, { new: true });
  if (!s) throw ApiError.notFound('Supplier not found');
  await AuditLog.create({ businessId, userId: user._id, action: 'supplier.approve', entityType: 'Supplier', entityId: s._id, newValue: { licenseNumber, licenseExpiry } });
  return { supplierId: s._id, name: s.name, state: approvalState(s), approval: s.pharmacyApproval };
}
async function revokeApproval(businessId, user, supplierId, { reason }) {
  const s = await Supplier.findOneAndUpdate({ _id: supplierId, businessId }, { $set: { 'pharmacyApproval.approved': false, 'pharmacyApproval.note': reason } }, { new: true });
  if (!s) throw ApiError.notFound('Supplier not found');
  await AuditLog.create({ businessId, userId: user._id, action: 'supplier.approval.revoke', entityType: 'Supplier', entityId: s._id, newValue: { reason } });
  return { supplierId: s._id, name: s.name, state: approvalState(s) };
}
async function listSuppliers(businessId) {
  const rows = await Supplier.find({ businessId, status: 'active' }).sort({ name: 1 }).select('name phone pharmacyApproval');
  return { suppliers: rows.map((s) => ({ supplierId: s._id, name: s.name, phone: s.phone, state: approvalState(s), licenseNumber: s.pharmacyApproval?.licenseNumber, licenseExpiry: s.pharmacyApproval?.licenseExpiry })) };
}

/** Called by purchase.service#createPurchase. Throws when a pharmacy would buy medicines from an unapproved supplier. */
async function assertApprovedForPurchase({ business, supplier, products }) {
  if (!business?.featureSettings?.pharmacyDispensing) return;
  if (business.pharmacySettings?.requireApprovedSuppliers === false) return;
  const meds = await MedicineDetails.countDocuments({ businessId: business._id || supplier.businessId, productId: { $in: products.map((p) => p._id) } });
  if (!meds) return;
  const state = approvalState(supplier);
  if (state !== 'APPROVED') throw ApiError.forbidden(state === 'LICENCE_EXPIRED' ? `${supplier.name}'s licence has expired. Update it before buying medicines.` : `${supplier.name} is not an approved medicine supplier. Record their licence first.`, 'SUPPLIER_NOT_APPROVED');
}

// ------------------------------------------------------------------ returns to supplier
async function createReturn(businessId, branchId, user, { supplierId, purchaseId, recallId, lines, notes }) {
  const supplier = await Supplier.findOne({ _id: supplierId, businessId });
  if (!supplier) throw ApiError.badRequest('Supplier not found', 'INVALID_SUPPLIER');
  const ids = lines.map((l) => String(l.batchId));
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('A batch is listed twice. Combine the quantities.', 'DUPLICATE_BATCH');
  return inTx(async (session) => {
    const built = []; let total = 0;
    for (const l of lines) {
      const batch = await Batch.findOne({ _id: l.batchId, businessId, branchId }).session(session);
      if (!batch) throw ApiError.badRequest('Batch not found at this branch', 'BATCH_NOT_FOUND');
      if (batch.supplierId && String(batch.supplierId) !== String(supplierId)) throw ApiError.badRequest(`Batch ${batch.batchNumber} was supplied by someone else. Return it to the right supplier.`, 'WRONG_SUPPLIER');
      if (!['active', 'quarantined', 'recalled'].includes(batch.status)) throw ApiError.conflict(`Batch ${batch.batchNumber} is ${batch.status}`, 'INVALID_BATCH_STATE');
      if (l.quantity > batch.quantity) throw ApiError.badRequest(`Batch ${batch.batchNumber} only has ${batch.quantity} left`, 'EXCEEDS_BATCH', [{ available: batch.quantity }]);
      const product = await Product.findOne({ _id: batch.productId, businessId }).session(session);
      if (batch.status === 'active') { // held batches are already outside sellable stock
        await applyStockChange({
          businessId, branchId, productId: batch.productId, variantId: batch.variantId || null, quantityDelta: -l.quantity, type: 'ADJUSTMENT_OUT',
          referenceType: 'SupplierReturn', referenceId: batch._id, reason: `Returned to ${supplier.name}: batch ${batch.batchNumber} (${l.reason})`, performedBy: user._id, session, location: batchService.locOf(batch),
        });
      }
      batch.quantity -= l.quantity;
      if (batch.quantity === 0 && batch.status === 'active') { batch.status = 'depleted'; batch.statusReason = 'Returned to supplier'; batch.statusChangedAt = new Date(); batch.statusChangedBy = user._id; }
      await batch.save({ session });
      const value = Math.round((batch.costPrice || 0) * l.quantity); total += value;
      built.push({ batchId: batch._id, productId: batch.productId, nameSnapshot: product?.name, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, quantity: l.quantity, unitCost: batch.costPrice || 0, reason: l.reason });
    }
    const seq = await nextSequence(businessId, 'supplierreturn:business', session);
    const [ret] = await SupplierReturn.create([{ businessId, branchId, number: `SR-${pad(seq)}`, supplierId, purchaseId, recallId, lines: built, totalValue: total, notes, createdBy: user._id }], { session });
    await AuditLog.create([{ businessId, branchId, userId: user._id, action: 'supplier.return', entityType: 'SupplierReturn', entityId: ret._id, newValue: { number: ret.number, supplierId, lines: built.length, totalValue: total } }], { session });
    return ret;
  });
}

/** The supplier's credit note. Applied to what we owe them as a payment (method OTHER) so statements and balances agree. */
async function recordCredit(businessId, user, id, { creditNoteNumber, amount }) {
  const ret = await SupplierReturn.findOne({ _id: id, businessId });
  if (!ret) throw ApiError.notFound('Return not found');
  if (ret.status === 'CREDITED') throw ApiError.conflict('A credit note is already recorded for this return', 'ALREADY_CREDITED');
  const finance = require('./supplier-finance.service');
  const supplier = await Supplier.findOne({ _id: ret.supplierId, businessId }).select('currentBalance');
  const owed = Math.max(0, supplier?.currentBalance || 0);
  const apply = Math.min(amount, owed);
  let paymentId;
  if (apply > 0) {
    const pay = await finance.recordSupplierPayment(businessId, user._id, { supplierId: ret.supplierId, amount: apply, method: 'OTHER', reference: creditNoteNumber, notes: `Credit note ${creditNoteNumber} for return ${ret.number}`, branchId: ret.branchId });
    paymentId = pay._id;
  }
  ret.status = 'CREDITED'; ret.creditNote = { number: creditNoteNumber, amount, appliedAmount: apply, paymentId, at: new Date(), by: user._id };
  await ret.save();
  await AuditLog.create({ businessId, branchId: ret.branchId, userId: user._id, action: 'supplier.credit', entityType: 'SupplierReturn', entityId: ret._id, newValue: { creditNoteNumber, amount, applied: apply } });
  return ret;
}

async function listReturns(businessId, { supplierId, status, page = 1, limit = 20 } = {}) {
  const filter = { businessId }; if (supplierId) filter.supplierId = supplierId; if (status) filter.status = status;
  const [rows, total] = await Promise.all([SupplierReturn.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), SupplierReturn.countDocuments(filter)]);
  return { returns: rows, total, page, limit };
}
async function getReturn(businessId, id) {
  const r = await SupplierReturn.findOne({ _id: id, businessId });
  if (!r) throw ApiError.notFound('Return not found');
  return r;
}

module.exports = { approvalState, setApproval, revokeApproval, listSuppliers, assertApprovedForPurchase, createReturn, recordCredit, listReturns, getReturn };