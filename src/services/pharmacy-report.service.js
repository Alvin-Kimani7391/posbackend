/**
 * Pharmacy compliance reports and the dashboard. Aggregate figures only on the dashboard: no patient or clinical detail.
 * The controlled-medicine register is built from the append-only stock movements, so it cannot disagree with stock.
 */
const Batch = require('../models/Batch');
const BranchInventory = require('../models/BranchInventory');
const InventoryMovement = require('../models/InventoryMovement');
const MedicineDetails = require('../models/MedicineDetails');
const DispensingRecord = require('../models/DispensingRecord');
const Prescription = require('../models/Prescription');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const Business = require('../models/Business');
const Sale = require('../models/Sale');
const StorageLog = require('../models/StorageLog');
const RecallRecord = require('../models/RecallRecord');
const User = require('../models/User');
const prescriptions = require('./prescription.service');
const guard = require('./pharmacy-guard.service');
const batchService = require('./batch.service');
const ApiError = require('../utils/ApiError');

const DAY = 86400000;
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

async function dashboard(businessId, { branchId } = {}) {
  await prescriptions.expireOld(businessId);
  const today = startOfDay(); const now = new Date(); const bf = branchId ? { branchId } : {};
  const live = { businessId, ...bf, status: 'active', quantity: { $gt: 0 } };
  const [expired, exp30, quarantined, recalled, pendingReviews, openExceptions, openRecalls, dispensedToday, salesToday, awaitingPOs, medicines] = await Promise.all([
    Batch.countDocuments({ ...live, expiryDate: { $lt: today } }),
    Batch.countDocuments({ ...live, expiryDate: { $gte: today, $lt: new Date(today.getTime() + 30 * DAY) } }),
    Batch.countDocuments({ businessId, ...bf, status: 'quarantined', quantity: { $gt: 0 } }),
    Batch.countDocuments({ businessId, ...bf, status: 'recalled', quantity: { $gt: 0 } }),
    Prescription.countDocuments({ businessId, ...bf, status: 'RECEIVED' }),
    StorageLog.countDocuments({ businessId, ...bf, 'exception.status': 'OPEN' }),
    RecallRecord.countDocuments({ businessId, status: 'OPEN' }),
    DispensingRecord.countDocuments({ businessId, ...bf, status: 'DISPENSED', createdAt: { $gte: today } }),
    Sale.find({ businessId, ...bf, saleStatus: 'COMPLETED', createdAt: { $gte: today } }).select('total').lean(),
    Purchase.countDocuments({ businessId, ...bf, receivedStatus: { $in: ['PENDING', 'PARTIAL'] } }),
    MedicineDetails.find({ businessId, status: { $in: ['active', 'discontinued'] } }).select('productId classification').lean(),
  ]);
  // low / out of stock across medicines (sum over branches unless one is chosen)
  const pids = medicines.map((m) => m.productId);
  let low = 0; let out = 0;
  if (pids.length) {
    const inv = await BranchInventory.find({ businessId, ...bf, productId: { $in: pids } }).select('productId quantity').lean();
    const have = new Map(); inv.forEach((i) => have.set(String(i.productId), (have.get(String(i.productId)) || 0) + i.quantity));
    const prods = await Product.find({ _id: { $in: pids }, businessId }).select('lowStockThreshold').lean();
    prods.forEach((p) => { const q = have.get(String(p._id)) || 0; if (q <= 0) out += 1; else if (q <= (p.lowStockThreshold ?? 5)) low += 1; });
  }
  const business = await Business.findById(businessId).select('pharmacySettings');
  const classes = guard.classesOf(business);
  const controlled = medicines.filter((m) => classes.get(String(m.classification).toUpperCase())?.restricted).length;
  return {
    asOf: now,
    today: { sales: salesToday.length, salesTotal: salesToday.reduce((s, x) => s + x.total, 0), dispensings: dispensedToday },
    stock: { expiredBatches: expired, expiringIn30Days: exp30, quarantinedBatches: quarantined, recalledBatchesHeld: recalled, lowStockMedicines: low, outOfStockMedicines: out },
    tasks: { prescriptionsAwaitingReview: pendingReviews, openStorageExceptions: openExceptions, openRecalls, purchaseOrdersAwaitingReceipt: awaitingPOs, controlledMedicinesToReconcile: controlled },
  };
}

async function dispensingReport(businessId, { from, to, groupBy = 'day', branchId }) {
  const filter = { businessId, status: 'DISPENSED' };
  if (branchId) filter.branchId = branchId;
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const rows = await DispensingRecord.find(filter).select('createdAt dispenserId items').limit(20000).lean();
  const g = new Map();
  const add = (key, label, units) => { const e = g.get(key) || { key, label, dispensings: 0, units: 0 }; e.dispensings += 1; e.units += units; g.set(key, e); };
  for (const r of rows) {
    const units = r.items.reduce((s, i) => s + i.quantity, 0);
    if (groupBy === 'day') add(r.createdAt.toISOString().slice(0, 10), undefined, units);
    else if (groupBy === 'dispenser') add(String(r.dispenserId), undefined, units);
    else r.items.forEach((i) => { const e = g.get(String(i.productId)) || { key: String(i.productId), label: `${i.nameSnapshot} ${i.strength || ''}`.trim(), dispensings: 0, units: 0 }; e.dispensings += 1; e.units += i.quantity; g.set(String(i.productId), e); });
  }
  const out = [...g.values()];
  if (groupBy === 'dispenser') { const us = await User.find({ _id: { $in: out.map((o) => o.key) } }).select('name'); const m = new Map(us.map((u) => [String(u._id), u.name])); out.forEach((o) => { o.label = m.get(o.key) || 'Unknown'; }); }
  out.sort((a, b) => (groupBy === 'day' ? a.key.localeCompare(b.key) : b.units - a.units));
  return { groupBy, rows: out, totals: { dispensings: rows.length, units: rows.reduce((t, r) => t + r.items.reduce((a, it) => a + it.quantity, 0), 0) } };
}

/** Prescription exceptions and authorisation audit: rejected / cancelled / expired, pharmacist interventions, reversed dispensings. */
async function exceptionsReport(businessId, { from, to }) {
  const range = from || to ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};
  await prescriptions.expireOld(businessId);
  const [rxs, reversed] = await Promise.all([
    Prescription.find({ businessId, ...range, $or: [{ status: { $in: ['REJECTED', 'CANCELLED', 'EXPIRED'] } }, { 'interventions.0': { $exists: true } }] }).sort({ createdAt: -1 }).limit(500).select('number status closure interventions review createdAt'),
    DispensingRecord.find({ businessId, status: 'REVERSED', ...range }).sort({ createdAt: -1 }).limit(500).select('number reversal createdAt dispenserId'),
  ]);
  const byStatus = {}; rxs.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  const interventions = {}; rxs.forEach((r) => r.interventions.forEach((i) => { interventions[i.type] = (interventions[i.type] || 0) + 1; }));
  return {
    prescriptions: rxs.map((r) => ({ number: r.number, status: r.status, reason: r.closure?.reason, closedBy: r.closure?.by, reviewedBy: r.review?.by, interventions: r.interventions.length, date: r.createdAt })),
    byStatus, interventions,
    reversals: reversed.map((d) => ({ number: d.number, reason: d.reversal?.reason, by: d.reversal?.by, at: d.reversal?.at, dispenserId: d.dispenserId })),
  };
}

/** Running register for one restricted medicine: every stock movement, with the dispensing it belongs to. */
async function controlledRegister(businessId, { productId, branchId, from, to }) {
  const [details, business] = await Promise.all([MedicineDetails.findOne({ businessId, productId }), Business.findById(businessId).select('pharmacySettings')]);
  if (!details) throw ApiError.notFound('No medicine details for this product');
  if (!guard.classFor(guard.classesOf(business), details).restricted) throw ApiError.badRequest('This medicine is not in a restricted class', 'NOT_RESTRICTED');
  const filter = { businessId, productId }; if (branchId) filter.branchId = branchId;
  const all = await InventoryMovement.find(filter).sort({ createdAt: 1 }).lean();
  const inRange = all.filter((m) => (!from || m.createdAt >= from) && (!to || m.createdAt <= to));
  const before = from ? all.filter((m) => m.createdAt < from) : [];
  const opening = before.length ? before[before.length - 1].newStock : (inRange[0] ? inRange[0].previousStock : 0);
  const saleIds = inRange.filter((m) => m.referenceType === 'Sale').map((m) => m.referenceId);
  const disp = saleIds.length ? await DispensingRecord.find({ businessId, saleId: { $in: saleIds } }).select('number saleId') : [];
  const dispBySale = new Map(disp.map((d) => [String(d.saleId), d.number]));
  const entries = inRange.map((m) => ({ at: m.createdAt, type: m.type, quantity: m.quantity, balance: m.newStock, reference: m.referenceType, reason: m.reason, by: m.performedBy, dispensing: m.referenceType === 'Sale' ? dispBySale.get(String(m.referenceId)) : undefined }));
  const current = await BranchInventory.find({ businessId, productId, ...(branchId ? { branchId } : {}) }).select('quantity').lean();
  return {
    medicine: { productId, genericName: details.genericName, strength: details.strength, dosageForm: details.dosageForm, classification: details.classification },
    opening, entries, received: inRange.filter((m) => m.quantity > 0).reduce((s, m) => s + m.quantity, 0), issued: -inRange.filter((m) => m.quantity < 0).reduce((s, m) => s + m.quantity, 0),
    closing: entries.length ? entries[entries.length - 1].balance : opening, systemQuantity: current.reduce((s, c) => s + c.quantity, 0),
  };
}

async function expiry(businessId, { branchId, days }) {
  const business = await Business.findById(businessId).select('pharmacySettings');
  const warn = business?.pharmacySettings?.expiryWarnDays?.length ? business.pharmacySettings.expiryWarnDays : [30, 60, 90];
  return { warnDays: warn, ...(await batchService.listExpiring(businessId, { branchId, days: days || Math.max(...warn) })) };
}

module.exports = { dashboard, dispensingReport, exceptionsReport, controlledRegister, expiry };