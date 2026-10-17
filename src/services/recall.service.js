/**
 * Recalls. Acting on a notice holds every batch with that number (the batch engine moves the units out of sellable stock),
 * records what was done, and traces which sales and dispensings touched those batches so affected patients can be reached.
 * Patient contact details are only returned to someone who may open patient records, and that read is audit-logged.
 */
const RecallRecord = require('../models/RecallRecord');
const Batch = require('../models/Batch');
const DispensingRecord = require('../models/DispensingRecord');
const Prescription = require('../models/Prescription');
const Patient = require('../models/Patient');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const batchService = require('./batch.service');
const guard = require('./pharmacy-guard.service');
const patients = require('./patient.service');
const { hasPermission } = require('../utils/permissionCheck');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');

async function load(businessId, id) {
  const r = await RecallRecord.findOne({ _id: id, businessId });
  if (!r) throw ApiError.notFound('Recall not found');
  return r;
}

async function initiate(businessId, user, { batchNumber, productId, branchId, reason, noticeReference, source }) {
  const out = await batchService.recallByBatchNumber(businessId, user._id, { batchNumber, productId, branchId, reason });
  const seq = await nextSequence(businessId, 'recall:business');
  const rec = await RecallRecord.create({
    businessId, number: `RC-${pad(seq)}`, noticeReference, source: source || 'OTHER', productId, batchNumber, reason,
    batchIds: out.batches.map((b) => b._id), unitsHeld: out.batches.reduce((s, b) => s + (b.quantity || 0), 0),
    actions: [{ at: new Date(), by: user._id, action: 'HELD', note: `${out.batches.length} batch record(s) held, ${out.affectedSales.length} sale(s) traced` }], createdBy: user._id,
  });
  await AuditLog.create({ businessId, userId: user._id, action: 'recall.initiate', entityType: 'RecallRecord', entityId: rec._id, newValue: { number: rec.number, batchNumber, noticeReference } });
  return { recall: rec, batches: out.batches, affectedSalesCount: out.affectedSales.length };
}

/** What was sold or dispensed from the recalled batches. Patients are included only for people allowed to see them. */
async function trace(businessId, user, id) {
  const rec = await load(businessId, id);
  const [batches, sales, dispensings] = await Promise.all([
    Batch.find({ _id: { $in: rec.batchIds }, businessId }).select('batchNumber productId branchId quantity status expiryDate'),
    batchService.tracedSales(businessId, rec.batchIds),
    DispensingRecord.find({ businessId, 'items.batchAllocations.batchId': { $in: rec.batchIds } }).sort({ createdAt: -1 }).limit(1000),
  ]);
  const seePatients = hasPermission(user, 'patients.view');
  let people = [];
  const rxs = dispensings.length ? await Prescription.find({ _id: { $in: dispensings.map((d) => d.prescriptionId) }, businessId }).select('number') : [];
  const rxNo = new Map(rxs.map((r) => [String(r._id), r.number]));
  if (seePatients && dispensings.length) {
    const ids = [...new Set(dispensings.map((d) => String(d.patientId)))];
    people = await Patient.find({ _id: { $in: ids }, businessId, status: 'active' }).select('number name phone');
    await patients.logRead(businessId, user, people.map((p) => p._id), `recall trace ${rec.number}`);
  }
  return {
    recall: rec, batches, salesCount: sales.length, sales,
    dispensings: dispensings.map((d) => ({ _id: d._id, number: d.number, date: d.createdAt, prescription: rxNo.get(String(d.prescriptionId)), status: d.status, patientId: seePatients ? d.patientId : undefined })),
    patients: seePatients ? people : undefined, patientsHidden: !seePatients,
  };
}

async function addAction(businessId, user, id, { action, note }) {
  const rec = await load(businessId, id);
  if (rec.status === 'CLOSED') throw ApiError.conflict('This recall is closed', 'RECALL_CLOSED');
  rec.actions.push({ at: new Date(), by: user._id, action, note });
  await rec.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'recall.action', entityType: 'RecallRecord', entityId: rec._id, newValue: { action } });
  return rec;
}

/** A pharmacist closes a recall once none of the held stock is left (all disposed or returned to the supplier). */
async function close(businessId, user, id, { note }) {
  const business = await Business.findById(businessId);
  if (!guard.credentialOk(user, business, ['PHARMACIST'])) throw ApiError.forbidden('Only a pharmacist can close a recall', 'CREDENTIAL_REQUIRED');
  const rec = await load(businessId, id);
  if (rec.status === 'CLOSED') return rec;
  const left = await Batch.countDocuments({ _id: { $in: rec.batchIds }, businessId, quantity: { $gt: 0 } });
  if (left) throw ApiError.conflict(`${left} batch record(s) still hold stock. Dispose of it or return it to the supplier first.`, 'STOCK_STILL_HELD');
  rec.status = 'CLOSED'; rec.closedBy = user._id; rec.closedAt = new Date(); rec.closeNote = note;
  rec.actions.push({ at: new Date(), by: user._id, action: 'CLOSED', note });
  await rec.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'recall.close', entityType: 'RecallRecord', entityId: rec._id, newValue: { note } });
  return rec;
}

async function list(businessId, { status, page = 1, limit = 20 } = {}) {
  const filter = { businessId }; if (status) filter.status = status;
  const [rows, total] = await Promise.all([RecallRecord.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), RecallRecord.countDocuments(filter)]);
  return { recalls: rows, total, page, limit };
}
const get = (businessId, id) => load(businessId, id);

module.exports = { initiate, trace, addAction, close, list, get };