/** Period returns of restricted (controlled) medicines, pharmacist-signed and then locked. */
const ControlledReturn = require('../models/ControlledReturn');
const MedicineDetails = require('../models/MedicineDetails');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const reports = require('./pharmacy-report.service');
const guard = require('./pharmacy-guard.service');
const extras = require('./pharmacy-extras.service');
const { hasPermission } = require('../utils/permissionCheck');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');

async function generate(businessId, user, { branchId, from, to }) {
  if (to <= from) throw ApiError.badRequest('The period must end after it starts', 'BAD_PERIOD');
  const business = await Business.findById(businessId).select('pharmacySettings');
  const classes = guard.classesOf(business);
  const meds = (await MedicineDetails.find({ businessId })).filter((m) => classes.get(String(m.classification).toUpperCase())?.restricted);
  if (!meds.length) throw ApiError.badRequest('No medicines are in a restricted class', 'NO_RESTRICTED_MEDICINES');
  const overlap = await ControlledReturn.findOne({ businessId, branchId, status: 'SIGNED', periodFrom: { $lt: to }, periodTo: { $gt: from } });
  if (overlap) throw ApiError.conflict(`Return ${overlap.number} already covers part of this period`, 'PERIOD_OVERLAP');
  const lines = [];
  for (const m of meds) {
    const r = await reports.controlledRegister(businessId, { productId: m.productId, branchId, from, to });
    lines.push({ productId: m.productId, name: m.genericName, strength: m.strength, dosageForm: m.dosageForm, classification: m.classification, opening: r.opening, received: r.received, issued: r.issued, closing: r.closing });
  }
  const seq = await nextSequence(businessId, 'controlledreturn:business');
  const ret = await ControlledReturn.create({ businessId, branchId, number: `CR-${pad(seq)}`, periodFrom: from, periodTo: to, lines, createdBy: user._id });
  await AuditLog.create({ businessId, branchId, userId: user._id, action: 'controlled.return.create', entityType: 'ControlledReturn', entityId: ret._id, newValue: { number: ret.number, lines: lines.length } });
  return ret;
}

async function recordCounts(businessId, user, id, counts) {
  const ret = await ControlledReturn.findOne({ _id: id, businessId });
  if (!ret) throw ApiError.notFound('Return not found');
  if (ret.status !== 'DRAFT') throw ApiError.conflict('A signed return is locked', 'RETURN_LOCKED');
  for (const c of counts) {
    const line = ret.lines.find((l) => String(l.productId) === String(c.productId));
    if (!line) throw ApiError.badRequest('That medicine is not on this return', 'NOT_ON_RETURN');
    line.countedQuantity = c.countedQuantity; line.variance = Math.round((c.countedQuantity - line.closing) * 1000) / 1000; if (c.note !== undefined) line.note = c.note;
  }
  await ret.save();
  return ret;
}

async function sign(businessId, user, id, { notes }) {
  const business = await Business.findById(businessId).select('pharmacySettings');
  if (!hasPermission(user, 'pharmacy.restricted')) throw ApiError.forbidden('You are not authorised to sign returns of restricted medicines', 'RESTRICTED_NOT_AUTHORISED');
  if (!guard.credentialOk(user, business, ['PHARMACIST'])) throw ApiError.forbidden('A verified pharmacist credential is needed to sign', 'CREDENTIAL_REQUIRED');
  const ret = await ControlledReturn.findOne({ _id: id, businessId });
  if (!ret) throw ApiError.notFound('Return not found');
  if (ret.status !== 'DRAFT') throw ApiError.conflict('Already signed', 'RETURN_LOCKED');
  const uncounted = ret.lines.filter((l) => l.countedQuantity === undefined || l.countedQuantity === null);
  if (uncounted.length) throw ApiError.badRequest(`${uncounted.length} medicine(s) have no physical count`, 'COUNT_MISSING', uncounted.map((l) => ({ productId: l.productId, name: l.name })));
  const noNote = ret.lines.filter((l) => l.variance && !l.note);
  if (noNote.length) throw ApiError.badRequest('Explain every variance before signing', 'VARIANCE_NOTE_REQUIRED', noNote.map((l) => ({ productId: l.productId, name: l.name, variance: l.variance })));
  ret.status = 'SIGNED'; ret.signedBy = user._id; ret.signedAt = new Date(); if (notes) ret.notes = notes;
  ret.signer = { name: user.name, role: user.pharmacyCredential?.role, registrationNumber: user.pharmacyCredential?.registrationNumber };
  await ret.save();
  await AuditLog.create({ businessId, branchId: ret.branchId, userId: user._id, action: 'controlled.return.sign', entityType: 'ControlledReturn', entityId: ret._id, newValue: { number: ret.number, variances: ret.lines.filter((l) => l.variance).length } });
  return ret;
}

async function get(businessId, id) { const r = await ControlledReturn.findOne({ _id: id, businessId }); if (!r) throw ApiError.notFound('Return not found'); return r; }
async function list(businessId, { branchId, status, page = 1, limit = 20 } = {}) {
  const f = { businessId }; if (branchId) f.branchId = branchId; if (status) f.status = status;
  const [rows, total] = await Promise.all([ControlledReturn.find(f).sort({ periodTo: -1 }).skip((page - 1) * limit).limit(limit), ControlledReturn.countDocuments(f)]);
  return { returns: rows, total, page, limit };
}
async function exportCsv(businessId, user, id) {
  const r = await get(businessId, id);
  const head = [['Return', r.number], ['Status', r.status], ['Period from', r.periodFrom], ['Period to', r.periodTo], ['Signed by', r.signer?.name], ['Registration no', r.signer?.registrationNumber], ['Signed at', r.signedAt]];
  const cell = (v) => extras.toCsv(['x'], [[v]]).split('\n')[1];
  const csv = `${head.map((h) => h.map(cell).join(',')).join('\n')}\n\n${extras.toCsv(['Medicine', 'Strength', 'Form', 'Class', 'Opening', 'Received', 'Issued', 'Closing (ledger)', 'Counted', 'Variance', 'Note'], r.lines.map((l) => [l.name, l.strength, l.dosageForm, l.classification, l.opening, l.received, l.issued, l.closing, l.countedQuantity, l.variance, l.note]))}`;
  await AuditLog.create({ businessId, userId: user._id, action: 'pharmacy.export', entityType: 'ControlledReturn', entityId: r._id, newValue: { kind: 'controlled-return', number: r.number } });
  return { filename: `controlled-return-${r.number}.csv`, csv };
}

module.exports = { generate, recordCounts, sign, get, list, exportCsv };