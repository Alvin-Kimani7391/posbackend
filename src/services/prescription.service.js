/**
 * Prescription intake and pharmacist review. Anyone with prescriptions.intake can record what arrived; only a verified
 * pharmacist can validate or reject it. A validated prescription is what the sale flow checks before dispensing.
 * The system records and enforces; it never decides clinical questions, suggests changes or authorises a medicine.
 */
const Prescription = require('../models/Prescription');
const Patient = require('../models/Patient');
const MedicineDetails = require('../models/MedicineDetails');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const guard = require('./pharmacy-guard.service');
const { rulesOf } = require('../constants/pharmacy');
const patients = require('./patient.service');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');

const DAY = 86400000;
const OPEN = ['RECEIVED', 'VALIDATED', 'PARTIALLY_DISPENSED'];

async function expireOld(businessId) {
  await Prescription.updateMany({ businessId, status: { $in: OPEN }, validUntil: { $lt: new Date() } }, { $set: { status: 'EXPIRED' } });
}
async function load(businessId, id) {
  await expireOld(businessId);
  const rx = await Prescription.findOne({ _id: id, businessId });
  if (!rx) throw ApiError.notFound('Prescription not found');
  return rx;
}

async function intake(businessId, branchId, user, input) {
  const business = await Business.findById(businessId);
  const patient = await Patient.findOne({ _id: input.patientId, businessId, status: 'active' });
  if (!patient) throw ApiError.badRequest('Patient not found', 'PATIENT_NOT_FOUND');
  const date = new Date(input.prescriptionDate);
  if (date.getTime() > Date.now() + DAY) throw ApiError.badRequest('The prescription is dated in the future', 'BAD_DATE');
  if (input.externalReference) {
    const dup = await Prescription.findOne({ businessId, externalReference: input.externalReference, 'prescriber.name': input.prescriber.name, status: { $nin: ['REJECTED', 'CANCELLED'] } });
    if (dup) throw ApiError.conflict(`This prescription was already recorded as ${dup.number}`, 'DUPLICATE_PRESCRIPTION');
  }
  const ids = input.items.map((i) => i.productId);
  if (new Set(ids.map(String)).size !== ids.length) throw ApiError.badRequest('A medicine is listed twice. Combine the quantities.', 'DUPLICATE_ITEM');
  const details = await MedicineDetails.find({ businessId, productId: { $in: ids } });
  const byProduct = new Map(details.map((d) => [String(d.productId), d]));
  const Product = require('../models/Product');
  const prods = await Product.find({ _id: { $in: ids }, businessId }).select('name');
  const nameOf = new Map(prods.map((p) => [String(p._id), p.name]));
  const items = input.items.map((i) => {
    const d = byProduct.get(String(i.productId));
    if (!d) throw ApiError.badRequest('That product has no medicine details. Set them up first.', 'NOT_A_MEDICINE');
    return { productId: i.productId, nameSnapshot: nameOf.get(String(i.productId)), genericName: d.genericName, strength: d.strength, dosageForm: d.dosageForm, prescribedQty: i.prescribedQty, directions: i.directions };
  });
  // Country rules: validity, refills and controlled drugs.
  const rules = rulesOf(business); const classes = guard.classesOf(business);
  const restrictedItems = details.filter((d) => guard.classFor(classes, d).restricted);
  if (restrictedItems.length && rules.noRefillsForRestricted && input.maxDispensings > 1) throw ApiError.badRequest('Refills are not allowed for controlled drugs', 'REFILLS_NOT_ALLOWED');
  if (restrictedItems.length && rules.oneRestrictedPerPrescription && input.items.length > 1) throw ApiError.badRequest('A controlled drug must be on its own prescription: one drug per prescription', 'ONE_CONTROLLED_PER_PRESCRIPTION');
  const validDays = input.maxDispensings > 1 ? rules.refillValidDays : rules.prescriptionValidDays;
  const maxUntil = new Date(date.getTime() + validDays * DAY);
  const validUntil = input.validUntil ? new Date(input.validUntil) : maxUntil;
  if (input.validUntil && rules.capValidity && validUntil.getTime() > maxUntil.getTime() + DAY) throw ApiError.badRequest(`A prescription is valid for ${validDays} days from its date`, 'VALIDITY_TOO_LONG', [{ maxValidUntil: maxUntil }]);
  if (validUntil.getTime() < Date.now()) throw ApiError.badRequest('This prescription is already out of date and cannot be accepted', 'PRESCRIPTION_EXPIRED');

  const seq = await nextSequence(businessId, 'prescription:business');
  const rx = await Prescription.create({
    businessId, branchId, number: `RX-${pad(seq)}`, externalReference: input.externalReference, patientId: patient._id, prescriber: input.prescriber,
    prescriptionDate: date, validUntil, maxDispensings: input.maxDispensings, minIntervalDays: input.minIntervalDays, items, receivedBy: user._id, interventions: [],
  });
  await AuditLog.create({ businessId, branchId, userId: user._id, action: 'prescription.intake', entityType: 'Prescription', entityId: rx._id, newValue: { number: rx.number, patientId: patient._id, items: items.length } });
  return rx;
}

/** Pharmacist decision. Validating requires a verified PHARMACIST credential; rejecting requires a reason. */
async function review(businessId, user, id, { decision, note, allergyChecked }) {
  const business = await Business.findById(businessId);
  if (!guard.credentialOk(user, business, ['PHARMACIST'])) throw ApiError.forbidden('Only a pharmacist with a verified credential can review a prescription', 'CREDENTIAL_REQUIRED');
  const rx = await load(businessId, id);
  if (rx.status !== 'RECEIVED') throw ApiError.conflict(`This prescription is ${rx.status}`, 'INVALID_PRESCRIPTION_STATE');
  if (decision === 'REJECT') {
    if (!note) throw ApiError.badRequest('A reason is required to reject a prescription', 'REASON_REQUIRED');
    rx.status = 'REJECTED'; rx.closure = { by: user._id, at: new Date(), reason: note };
  } else {
    if (allergyChecked !== true) throw ApiError.badRequest('Confirm that the patient\'s allergy information was checked', 'ALLERGY_CHECK_REQUIRED');
    rx.status = 'VALIDATED';
  }
  rx.review = { by: user._id, at: new Date(), note, allergyChecked: allergyChecked === true };
  await rx.save();
  await AuditLog.create({ businessId, branchId: rx.branchId, userId: user._id, action: decision === 'REJECT' ? 'prescription.reject' : 'prescription.validate', entityType: 'Prescription', entityId: rx._id, newValue: { number: rx.number, note } });
  return rx;
}

async function addIntervention(businessId, user, id, { type, note }) {
  const business = await Business.findById(businessId);
  if (!guard.credentialOk(user, business, ['PHARMACIST'])) throw ApiError.forbidden('Only a pharmacist can record an intervention', 'CREDENTIAL_REQUIRED');
  const rx = await load(businessId, id);
  if (!OPEN.includes(rx.status)) throw ApiError.conflict(`This prescription is ${rx.status}`, 'INVALID_PRESCRIPTION_STATE');
  rx.interventions.push({ at: new Date(), by: user._id, type, note });
  await rx.save();
  await AuditLog.create({ businessId, branchId: rx.branchId, userId: user._id, action: 'prescription.intervention', entityType: 'Prescription', entityId: rx._id, newValue: { type } });
  return rx;
}

async function cancel(businessId, user, id, { reason }) {
  const rx = await load(businessId, id);
  if (!OPEN.includes(rx.status)) throw ApiError.conflict(`This prescription is ${rx.status}`, 'INVALID_PRESCRIPTION_STATE');
  rx.status = 'CANCELLED'; rx.closure = { by: user._id, at: new Date(), reason };
  await rx.save();
  await AuditLog.create({ businessId, branchId: rx.branchId, userId: user._id, action: 'prescription.cancel', entityType: 'Prescription', entityId: rx._id, newValue: { reason } });
  return rx;
}

async function get(businessId, user, id) {
  const rx = await load(businessId, id);
  await patients.logRead(businessId, user, [rx.patientId], `prescription ${rx.number}`);
  return rx;
}

async function list(businessId, user, { status, patientId, pendingReview, search, page = 1, limit = 20 } = {}) {
  await expireOld(businessId);
  const filter = { businessId };
  if (pendingReview) filter.status = 'RECEIVED'; else if (status) filter.status = status;
  if (patientId) filter.patientId = patientId;
  if (search) filter.number = new RegExp(`^${String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const [rows, total] = await Promise.all([Prescription.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), Prescription.countDocuments(filter)]);
  if (patientId) await patients.logRead(businessId, user, [patientId], 'prescription list');
  return { prescriptions: rows, total, page, limit };
}

module.exports = { intake, review, addIntervention, cancel, get, list, expireOld };