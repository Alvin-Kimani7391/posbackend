/**
 * Patients: kept apart from Customer so CRM, SMS campaigns and sales reports never see them. Every read is audit-logged
 * (who looked at whom, when). Erasure removes personal data but never inside the configured retention period.
 */
const Patient = require('../models/Patient');
const Prescription = require('../models/Prescription');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { normalizePhone } = require('../utils/phone');
const { nextSequence, pad } = require('../models/Counter');

const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const logRead = (businessId, user, patientIds, how) =>
  AuditLog.create({ businessId, userId: user._id, action: 'patient.view', entityType: 'Patient', entityId: patientIds.length === 1 ? patientIds[0] : undefined, newValue: { how, count: patientIds.length, ids: patientIds.slice(0, 50) } });

async function create(businessId, user, input) {
  if (!input.consent || !input.consent.basis) throw ApiError.badRequest('Record the consent or lawful basis for keeping this patient\'s details', 'CONSENT_REQUIRED');
  let phone = input.phone;
  if (phone) { phone = normalizePhone(phone); if (!phone) throw ApiError.badRequest('Invalid phone number', 'BAD_PHONE'); }
  if (input.idNumber) {
    const dup = await Patient.findOne({ businessId, idNumber: input.idNumber, idType: input.idType, status: 'active' });
    if (dup) throw ApiError.conflict(`This patient is already on file (${dup.number})`, 'PATIENT_EXISTS');
  }
  const seq = await nextSequence(businessId, 'patient:business');
  const p = await Patient.create({
    businessId, number: `PT-${pad(seq)}`, name: input.name, phone, idType: input.idType, idNumber: input.idNumber, dateOfBirth: input.dateOfBirth, sex: input.sex,
    allergies: input.allergies || [], notes: input.notes, consent: { given: input.consent.given !== false, basis: input.consent.basis, at: new Date(), recordedBy: user._id }, createdBy: user._id,
  });
  await AuditLog.create({ businessId, userId: user._id, action: 'patient.create', entityType: 'Patient', entityId: p._id, newValue: { number: p.number } });
  return p;
}

async function update(businessId, user, id, input) {
  const p = await Patient.findOne({ _id: id, businessId });
  if (!p) throw ApiError.notFound('Patient not found');
  if (p.status === 'erased') throw ApiError.conflict('This patient record has been erased', 'PATIENT_ERASED');
  const changed = [];
  for (const f of ['name', 'dateOfBirth', 'sex', 'allergies', 'notes', 'idType', 'idNumber']) if (input[f] !== undefined) { p[f] = input[f]; changed.push(f); }
  if (input.phone !== undefined) { const n = input.phone ? normalizePhone(input.phone) : undefined; if (input.phone && !n) throw ApiError.badRequest('Invalid phone number', 'BAD_PHONE'); p.phone = n; changed.push('phone'); }
  await p.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'patient.update', entityType: 'Patient', entityId: p._id, newValue: { fields: changed } }); // field names only, never the values
  return p;
}

async function get(businessId, user, id) {
  const p = await Patient.findOne({ _id: id, businessId });
  if (!p) throw ApiError.notFound('Patient not found');
  await logRead(businessId, user, [p._id], 'open');
  return p;
}

async function search(businessId, user, { q, page = 1, limit = 20 }) {
  const filter = { businessId, status: 'active' };
  if (q) filter.$or = [{ name: rx(q) }, { number: rx(q) }, { phone: rx(q) }, { idNumber: rx(q) }];
  const [rows, total] = await Promise.all([Patient.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).select('number name phone dateOfBirth'), Patient.countDocuments(filter)]);
  await logRead(businessId, user, rows.map((r) => r._id), 'search');
  return { patients: rows, total, page, limit };
}

async function history(businessId, user, id) {
  const p = await Patient.findOne({ _id: id, businessId });
  if (!p) throw ApiError.notFound('Patient not found');
  const rxs = await Prescription.find({ businessId, patientId: id }).sort({ createdAt: -1 }).limit(200).select('number status prescriptionDate prescriber.name items.nameSnapshot items.prescribedQty items.dispensedQty');
  await logRead(businessId, user, [p._id], 'history');
  return { patient: p, prescriptions: rxs };
}

/** Removes personal data. Refused while the record is inside the retention period (the newest prescription decides). */
async function erase(businessId, user, id, { reason }) {
  const p = await Patient.findOne({ _id: id, businessId });
  if (!p) throw ApiError.notFound('Patient not found');
  if (p.status === 'erased') return p;
  const b = await Business.findById(businessId).select('pharmacySettings');
  const years = b?.pharmacySettings?.recordRetentionYears ?? 7;
  const newest = await Prescription.findOne({ businessId, patientId: id }).sort({ createdAt: -1 }).select('createdAt');
  if (newest) {
    const until = new Date(newest.createdAt); until.setFullYear(until.getFullYear() + years);
    if (until > new Date()) throw ApiError.conflict(`Records must be kept until ${until.toISOString().slice(0, 10)} (${years}-year retention). Erase after that date.`, 'RETENTION_PERIOD', [{ keepUntil: until }]);
  }
  p.name = 'ERASED'; p.phone = undefined; p.idNumber = undefined; p.idType = undefined; p.dateOfBirth = undefined; p.sex = undefined; p.allergies = []; p.notes = undefined; p.status = 'erased';
  await p.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'patient.erase', entityType: 'Patient', entityId: p._id, newValue: { reason } });
  return p;
}

module.exports = { create, update, get, search, history, erase, logRead };