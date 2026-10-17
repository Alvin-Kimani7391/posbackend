/** Medicine master data, pharmacy rules (classes, limits) and staff professional credentials. */
const MedicineDetails = require('../models/MedicineDetails');
const Product = require('../models/Product');
const Business = require('../models/Business');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const guard = require('./pharmacy-guard.service');
const crypto = require('crypto');
const { CREDENTIAL_ROLES, profileFor, rulesOf } = require('../constants/pharmacy');
const ApiError = require('../utils/ApiError');

const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

async function assertClass(businessId, code) {
  const business = await Business.findById(businessId).select('pharmacySettings');
  if (!guard.classesOf(business).has(String(code).toUpperCase())) throw ApiError.badRequest(`"${code}" is not one of this pharmacy's classes. Add it in the pharmacy settings first.`, 'UNKNOWN_CLASS');
}

async function upsert(businessId, user, productId, input) {
  const product = await Product.findOne({ _id: productId, businessId });
  if (!product) throw ApiError.notFound('Product not found');
  if (product.productType === 'service') throw ApiError.badRequest('A service cannot be a medicine', 'NOT_A_MEDICINE');
  if (input.classification) await assertClass(businessId, input.classification);
  const existing = await MedicineDetails.findOne({ businessId, productId });
  const before = existing ? existing.toObject() : null;
  const doc = existing || new MedicineDetails({ businessId, productId });
  const fields = ['brandName', 'genericName', 'strength', 'dosageForm', 'packSize', 'manufacturer', 'registrationNumber', 'supplierCode', 'classification', 'storage', 'unitOfSale', 'infoReference'];
  fields.forEach((f) => { if (input[f] !== undefined) doc[f] = input[f]; });
  if (input.alternatives) {
    if (input.alternatives.some((a) => String(a) === String(productId))) throw ApiError.badRequest('A medicine cannot be its own alternative', 'BAD_ALTERNATIVE');
    const found = await Product.countDocuments({ _id: { $in: input.alternatives }, businessId });
    if (found !== input.alternatives.length) throw ApiError.badRequest('One of the alternatives is not a product of this business', 'PRODUCT_NOT_FOUND');
    doc.alternatives = input.alternatives;
  }
  doc.updatedBy = user._id;
  await doc.save();
  // Medicines must always be batch/expiry tracked (the batch engine then enforces FEFO and expiry on every sale).
  if (!product.trackBatch || !product.trackExpiry) await Product.updateOne({ _id: product._id }, { $set: { trackBatch: true, trackExpiry: true, trackInventory: true } });
  await AuditLog.create({ businessId, userId: user._id, action: before ? 'medicine.update' : 'medicine.create', entityType: 'MedicineDetails', entityId: doc._id, oldValue: before ? { classification: before.classification, status: before.status } : undefined, newValue: { classification: doc.classification, genericName: doc.genericName, strength: doc.strength } });
  return doc;
}

async function get(businessId, productId) {
  const d = await MedicineDetails.findOne({ businessId, productId });
  if (!d) throw ApiError.notFound('No medicine details for this product');
  return d;
}

async function list(businessId, { q, classification, status, dosageForm, page = 1, limit = 25 } = {}) {
  const filter = { businessId };
  if (classification) filter.classification = String(classification).toUpperCase();
  if (status) filter.status = status;
  if (dosageForm) filter.dosageForm = String(dosageForm).toLowerCase();
  if (q) filter.$or = [{ genericName: rx(q) }, { brandName: rx(q) }, { strength: rx(q) }];
  const [rows, total] = await Promise.all([MedicineDetails.find(filter).sort({ genericName: 1, strength: 1 }).skip((page - 1) * limit).limit(limit), MedicineDetails.countDocuments(filter)]);
  return { medicines: rows, total, page, limit };
}

/**
 * Other products with the SAME active ingredient, strength and dosage form, plus the pharmacist's own curated list.
 * Suggestions only: choosing a substitute is the pharmacist's decision, the system never swaps a medicine.
 */
async function alternatives(businessId, productId) {
  const d = await get(businessId, productId);
  const same = await MedicineDetails.find({ businessId, productId: { $ne: productId }, genericName: new RegExp(`^${String(d.genericName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), strength: d.strength, dosageForm: d.dosageForm, status: 'active' });
  const curated = d.alternatives?.length ? await MedicineDetails.find({ businessId, productId: { $in: d.alternatives }, status: 'active' }) : [];
  const seen = new Set(); const out = [];
  for (const m of [...same.map((x) => ({ m: x, basis: 'SAME_INGREDIENT_STRENGTH_FORM' })), ...curated.map((x) => ({ m: x, basis: 'PHARMACIST_LISTED' }))]) {
    if (seen.has(String(m.m.productId))) continue; seen.add(String(m.m.productId));
    out.push({ productId: m.m.productId, brandName: m.m.brandName, genericName: m.m.genericName, strength: m.m.strength, dosageForm: m.m.dosageForm, basis: m.basis });
  }
  return { alternatives: out };
}

async function setStatus(businessId, user, productId, { status, reason }) {
  const d = await get(businessId, productId);
  if (status !== 'active' && !reason) throw ApiError.badRequest('A reason is required', 'REASON_REQUIRED');
  const old = d.status; d.status = status; d.statusReason = status === 'active' ? undefined : reason; d.updatedBy = user._id;
  await d.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'medicine.status', entityType: 'MedicineDetails', entityId: d._id, oldValue: { status: old }, newValue: { status, reason } });
  return d;
}

// ------------------------------------------------------------------ settings + credentials
const classFingerprint = (business) => crypto.createHash('sha1').update(JSON.stringify([...guard.classesOf(business).values()].map((c) => [c.code, !!c.requiresPrescription, !!c.dispenserOnly, !!c.restricted, !!c.poisonsBook, c.maxQtyPerDispense || 0]).sort())).digest('hex');
const settingsView = (business) => {
  const s = business.pharmacySettings || {};
  const prof = profileFor(business); const rules = rulesOf(business); const cc = s.classesConfirmed;
  return {
    country: prof.country, regulator: prof.regulator, registrationLabel: prof.registrationLabel, renewalNote: prof.renewalNote,
    rules,
    classesConfirmed: !!(cc && cc.fingerprint === classFingerprint(business)), classesConfirmation: cc && cc.fingerprint === classFingerprint(business) ? { at: cc.at, byName: cc.byName, registrationNumber: cc.registrationNumber } : null,
    classes: [...guard.classesOf(business).values()],
    usingDefaultClasses: !(s.classes && s.classes.length),
    prescriptionValidDays: rules.prescriptionValidDays, recordRetentionYears: s.recordRetentionYears ?? 7,
    requireDispenserCredential: s.requireDispenserCredential !== false, allowOfflineOtc: s.allowOfflineOtc === true, requireApprovedSuppliers: s.requireApprovedSuppliers !== false,
    expiryWarnDays: s.expiryWarnDays?.length ? s.expiryWarnDays : [30, 60, 90], rooms: s.rooms || [],
    notice: 'These rules are yours to set from the current PPB requirements. The software does not make a pharmacy compliant.',
  };
};
async function getSettings(businessId) { return settingsView(await Business.findById(businessId).select('pharmacySettings')); }

async function updateSettings(businessId, user, input) {
  if (input.classes) {
    const codes = input.classes.map((c) => c.code.toUpperCase());
    if (new Set(codes).size !== codes.length) throw ApiError.badRequest('Two classes have the same code', 'DUPLICATE_CLASS');
    if (!codes.includes('OTC')) throw ApiError.badRequest('Keep an OTC class so ordinary products stay sellable', 'OTC_REQUIRED');
    const orphaned = await MedicineDetails.countDocuments({ businessId, classification: { $nin: codes } });
    if (orphaned) throw ApiError.conflict(`${orphaned} medicine(s) use a class you removed. Reclassify them first.`, 'CLASS_IN_USE');
  }
  const set = {};
  for (const k of ['classes', 'prescriptionValidDays', 'refillValidDays', 'noRefillsForRestricted', 'oneRestrictedPerPrescription', 'requireCountersign', 'recordRetentionYears', 'requireDispenserCredential', 'allowOfflineOtc', 'requireApprovedSuppliers', 'expiryWarnDays', 'rooms']) if (input[k] !== undefined) set[`pharmacySettings.${k}`] = input[k];
  const b = await Business.findOneAndUpdate({ _id: businessId }, { $set: set }, { new: true });
  await AuditLog.create({ businessId, userId: user._id, action: 'pharmacy.settings', entityType: 'Business', entityId: businessId, newValue: input });
  return settingsView(b);
}

/** A registered pharmacist signs off that the classes match the regulator's current lists. Changing a class voids the sign-off. */
async function confirmClasses(businessId, user, { statement }) {
  const business = await Business.findById(businessId).select('pharmacySettings countryCode');
  if (!(user.pharmacyCredential && guard.credentialOk(user, { pharmacySettings: { requireDispenserCredential: true } }, ['PHARMACIST']))) throw ApiError.forbidden('Only a pharmacist with a verified credential can confirm the classes', 'CREDENTIAL_REQUIRED');
  const conf = { at: new Date(), by: user._id, byName: user.name, registrationNumber: user.pharmacyCredential?.registrationNumber, fingerprint: classFingerprint(business) };
  await Business.updateOne({ _id: businessId }, { $set: { 'pharmacySettings.classesConfirmed': conf } });
  await AuditLog.create({ businessId, userId: user._id, action: 'pharmacy.classes.confirm', entityType: 'Business', entityId: businessId, newValue: { registrationNumber: conf.registrationNumber, statement } });
  return { confirmed: true, at: conf.at, by: user.name };
}

async function setCredential(businessId, actor, userId, { role, registrationNumber, expiresAt }) {
  if (!CREDENTIAL_ROLES.includes(role)) throw ApiError.badRequest('Invalid role', 'BAD_ROLE');
  if (role !== 'ASSISTANT' && !registrationNumber) throw ApiError.badRequest('A registration number is required for a pharmacist or dispenser', 'REGISTRATION_REQUIRED');
  const u = await User.findOneAndUpdate({ _id: userId, businessId }, { $set: { pharmacyCredential: { role, registrationNumber, expiresAt, verifiedAt: new Date(), verifiedBy: actor._id } } }, { new: true });
  if (!u) throw ApiError.notFound('Employee not found');
  await AuditLog.create({ businessId, userId: actor._id, action: 'pharmacy.credential.set', entityType: 'User', entityId: u._id, newValue: { role, registrationNumber, expiresAt } });
  return { userId: u._id, name: u.name, credential: u.pharmacyCredential };
}
async function revokeCredential(businessId, actor, userId) {
  const u = await User.findOneAndUpdate({ _id: userId, businessId }, { $unset: { pharmacyCredential: '' } }, { new: true });
  if (!u) throw ApiError.notFound('Employee not found');
  await AuditLog.create({ businessId, userId: actor._id, action: 'pharmacy.credential.revoke', entityType: 'User', entityId: u._id, newValue: {} });
  return { userId: u._id, credential: null };
}
async function listStaff(businessId) {
  const users = await User.find({ businessId, status: 'active' }).select('name role employeeCode pharmacyCredential grantedPermissions');
  return { staff: users.map((u) => ({ userId: u._id, name: u.name, role: u.role, employeeCode: u.employeeCode, credential: u.pharmacyCredential || null })) };
}

module.exports = { classFingerprint, confirmClasses, upsert, get, list, alternatives, setStatus, getSettings, updateSettings, setCredential, revokeCredential, listStaff };