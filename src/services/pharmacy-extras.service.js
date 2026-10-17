/**
 * Pharmacy: replenishment suggestions, patient-record access and retention reports, and regulatory CSV exports.
 */
const BranchInventory = require('../models/BranchInventory');
const InventoryMovement = require('../models/InventoryMovement');
const MedicineDetails = require('../models/MedicineDetails');
const DispensingRecord = require('../models/DispensingRecord');
const Prescription = require('../models/Prescription');
const PoisonsBookEntry = require('../models/PoisonsBookEntry');
const Patient = require('../models/Patient');
const Batch = require('../models/Batch');
const Product = require('../models/Product');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const reports = require('./pharmacy-report.service');
const { hasPermission } = require('../utils/permissionCheck');
const ApiError = require('../utils/ApiError');

const DAY = 86400000;
const csvCell = (v) => { if (v === undefined || v === null) return ''; let s = v instanceof Date ? v.toISOString() : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (header, rows) => [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');

/** Suggested order quantities from the last N days of sales. Expiring stock is not counted as cover. */
async function replenishment(businessId, { branchId, lookbackDays = 60, leadDays = 7, safetyDays = 7 }) {
  const now = new Date(); const since = new Date(now.getTime() - lookbackDays * DAY);
  const mf = { businessId, type: 'SALE', createdAt: { $gte: since } }; if (branchId) mf.branchId = branchId;
  const sold = await InventoryMovement.aggregate([{ $match: mf }, { $group: { _id: '$productId', units: { $sum: { $abs: '$quantity' } } } }]);
  if (!sold.length) return { lookbackDays, leadDays, safetyDays, suggestions: [] };
  const ids = sold.map((s) => s._id);
  const bf = { businessId, productId: { $in: ids } }; if (branchId) bf.branchId = branchId;
  const horizon = new Date(now.getTime() + (leadDays + safetyDays) * DAY);
  const [inv, soon, meds, prods] = await Promise.all([
    BranchInventory.find(bf).select('productId quantity').lean(),
    Batch.find({ ...bf, status: 'active', quantity: { $gt: 0 }, expiryDate: { $lt: horizon } }).select('productId quantity').lean(),
    MedicineDetails.find({ businessId, productId: { $in: ids } }).select('productId genericName strength dosageForm').lean(),
    Product.find({ _id: { $in: ids } }).select('name').lean(),
  ]);
  const sum = (rows) => { const m = new Map(); rows.forEach((r) => m.set(String(r.productId), (m.get(String(r.productId)) || 0) + r.quantity)); return m; };
  const onHand = sum(inv), expiring = sum(soon);
  const medBy = new Map(meds.map((m) => [String(m.productId), m])); const nameBy = new Map(prods.map((p) => [String(p._id), p.name]));
  const out = [];
  for (const s of sold) {
    const k = String(s._id); const daily = s.units / lookbackDays;
    const usable = Math.max(0, (onHand.get(k) || 0) - (expiring.get(k) || 0));
    const target = Math.ceil(daily * (leadDays + safetyDays)); const need = Math.max(0, target - usable);
    if (!need) continue;
    const m = medBy.get(k);
    out.push({ productId: s._id, name: m ? `${m.genericName} ${m.strength} ${m.dosageForm}` : nameBy.get(k), dailyUse: Math.round(daily * 100) / 100, onHand: onHand.get(k) || 0, expiringBeforeArrival: expiring.get(k) || 0, daysOfCover: daily ? Math.round((usable / daily) * 10) / 10 : null, suggestedOrder: need });
  }
  out.sort((a, b) => (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9));
  return { lookbackDays, leadDays, safetyDays, suggestions: out };
}

/** Who looked at patient records, and how often (from the audit log). Never shows patient details. */
async function accessReport(businessId, { from, to, userId }) {
  const f = { businessId, action: { $in: ['patient.view', 'patient.create', 'patient.update', 'patient.erase', 'prescription.view', 'dispensing.view'] } };
  if (userId) f.userId = userId;
  if (from || to) f.timestamp = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const rows = await AuditLog.find(f).sort({ timestamp: -1 }).limit(5000).select('userId action timestamp newValue').lean();
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.userId)))] } }).select('name').lean();
  const nm = new Map(users.map((u) => [String(u._id), u.name]));
  const by = new Map();
  for (const r of rows) {
    const k = String(r.userId); const e = by.get(k) || { userId: r.userId, name: nm.get(k) || 'Unknown', views: 0, edits: 0, recordsViewed: 0, bulkLookups: 0, lastAt: r.timestamp };
    if (r.action.endsWith('.view')) { e.views += 1; const c = r.newValue?.count || 1; e.recordsViewed += c; if (c > 10) e.bulkLookups += 1; } else e.edits += 1;
    by.set(k, e);
  }
  const users2 = [...by.values()].sort((a, b) => b.recordsViewed - a.recordsViewed);
  return { users: users2, totalEvents: rows.length, review: users2.filter((u) => u.bulkLookups > 0).map((u) => u.userId) };
}

/** Records that have reached the end of the retention period and can be erased, and those still held. */
async function retentionReport(businessId) {
  const biz = await Business.findById(businessId).select('pharmacySettings');
  const years = biz?.pharmacySettings?.recordRetentionYears ?? 7;
  const patients = await Patient.find({ businessId, status: 'active' }).select('number createdAt').lean();
  const last = await Prescription.aggregate([{ $match: { businessId, patientId: { $in: patients.map((p) => p._id) } } }, { $group: { _id: '$patientId', at: { $max: '$createdAt' } } }]);
  const lastBy = new Map(last.map((l) => [String(l._id), l.at]));
  const now = new Date(); const eligible = []; let held = 0;
  for (const p of patients) {
    const at = lastBy.get(String(p._id)) || p.createdAt; const until = new Date(at); until.setFullYear(until.getFullYear() + years);
    if (until <= now) eligible.push({ patientId: p._id, number: p.number, keepUntil: until }); else held += 1;
  }
  return { retentionYears: years, eligibleForErasure: eligible, heldCount: held };
}

/** Dispensing register CSV. Patient identity only for staff allowed to see patients; the export is itself audited. */
async function exportDispensing(businessId, user, { from, to, branchId }) {
  const withPatient = hasPermission(user, 'patients.view');
  const f = { businessId }; if (branchId) f.branchId = branchId;
  if (from || to) f.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const rows = await DispensingRecord.find(f).sort({ createdAt: 1 }).limit(50000).lean();
  const [pats, rxs] = await Promise.all([withPatient ? Patient.find({ _id: { $in: rows.map((r) => r.patientId) } }).select('number name').lean() : [], Prescription.find({ _id: { $in: rows.map((r) => r.prescriptionId) } }).select('number prescriber prescriptionDate').lean()]);
  const pm = new Map(pats.map((p) => [String(p._id), p])); const rm = new Map(rxs.map((r) => [String(r._id), r]));
  const lines = [];
  for (const r of rows) for (const i of r.items) lines.push([
    r.createdAt, r.number, r.status, rm.get(String(r.prescriptionId))?.number, rm.get(String(r.prescriptionId))?.prescriber?.name,
    withPatient ? pm.get(String(r.patientId))?.number : '', withPatient ? pm.get(String(r.patientId))?.name : '',
    i.nameSnapshot, i.strength, i.dosageForm, i.quantity, (i.batchAllocations || []).map((b) => `${b.batchNumber}x${b.quantity}`).join(' '),
    r.dispenserSnapshot?.name, r.dispenserSnapshot?.registrationNumber,
    rm.get(String(r.prescriptionId))?.prescriber?.facility, rm.get(String(r.prescriptionId))?.prescriber?.registrationNumber, r.countersign?.name,
  ]);
  await AuditLog.create({ businessId, userId: user._id, action: 'pharmacy.export', entityType: 'DispensingRecord', newValue: { kind: 'dispensing', rows: lines.length, withPatient, from, to } });
  return { filename: 'dispensing-register.csv', csv: toCsv(['Date', 'Dispensing', 'Status', 'Prescription', 'Prescriber', 'Patient no', 'Patient', 'Medicine', 'Strength', 'Form', 'Quantity', 'Batches', 'Dispenser', 'Registration no', 'Prescriber facility', 'Prescriber reg no', 'Countersigned by'], lines) };
}

async function exportControlled(businessId, user, query) {
  const r = await reports.controlledRegister(businessId, query);
  await AuditLog.create({ businessId, userId: user._id, action: 'pharmacy.export', entityType: 'Product', entityId: query.productId, newValue: { kind: 'controlled', rows: r.entries.length } });
  const head = [['Medicine', `${r.medicine.genericName} ${r.medicine.strength} ${r.medicine.dosageForm}`], ['Opening', r.opening], ['Received', r.received], ['Issued', r.issued], ['Closing', r.closing], ['System quantity', r.systemQuantity]];
  const csv = `${head.map((h) => h.map(csvCell).join(',')).join('\n')}\n\n${toCsv(['Date', 'Type', 'Quantity', 'Balance', 'Reference', 'Dispensing', 'Reason'], r.entries.map((e) => [e.at, e.type, e.quantity, e.balance, e.reference, e.dispensing, e.reason]))}`;
  return { filename: 'controlled-register.csv', csv };
}

/** The Poisons Book (Kenya). Purchaser names and addresses are personal data: the read is audit-logged. */
async function listPoisonsBook(businessId, user, { from, to, page = 1, limit = 20 }) {
  const f = { businessId }; if (from || to) f.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [rows, total] = await Promise.all([PoisonsBookEntry.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), PoisonsBookEntry.countDocuments(f)]);
  await AuditLog.create({ businessId, userId: user._id, action: 'poisonsbook.view', entityType: 'PoisonsBookEntry', newValue: { count: rows.length } });
  return { entries: rows, total, page, limit };
}

module.exports = { listPoisonsBook, replenishment, accessReport, retentionReport, exportDispensing, exportControlled, toCsv };