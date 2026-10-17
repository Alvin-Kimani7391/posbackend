/**
 * The server-side gate between a till and a medicine. createSale calls assess() BEFORE it opens its transaction and
 * recordWithinSale() INSIDE it, so these rules cannot be skipped by any client:
 *
 *   - a recalled / quarantined medicine cannot be sold (expired and quarantined BATCHES are already refused by the batch engine)
 *   - prescription-only / controlled items need a validated, in-date prescription that still has the quantity left
 *   - dispenser-only / prescription / restricted items need the right permission AND a verified professional credential
 *   - every dispensing is written to a DispensingRecord linking prescription, patient, dispenser, sale and batches
 *
 * Classes and limits come from Business.pharmacySettings (configurable); nothing here assumes a particular schedule.
 */
const MedicineDetails = require('../models/MedicineDetails');
const Prescription = require('../models/Prescription');
const Patient = require('../models/Patient');
const DispensingRecord = require('../models/DispensingRecord');
const Sale = require('../models/Sale');
const AuditLog = require('../models/AuditLog');
const { defaultClassesFor, rulesOf } = require('../constants/pharmacy');
const PoisonsBookEntry = require('../models/PoisonsBookEntry');
const { hasPermission } = require('../utils/permissionCheck');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');

const isOn = (business) => business?.featureSettings?.pharmacyDispensing === true;

function classesOf(business) {
  const configured = business?.pharmacySettings?.classes || [];
  const list = configured.length ? configured : defaultClassesFor(business);
  return new Map(list.map((c) => [String(c.code).toUpperCase(), c]));
}
// A code that is no longer configured is treated as the strictest class, never as "no rules".
const UNKNOWN_CLASS = Object.freeze({ code: 'UNKNOWN', requiresPrescription: true, dispenserOnly: true, restricted: true });
const classFor = (classes, details) => (!details ? classes.get('OTC') || { code: 'OTC' } : classes.get(String(details.classification).toUpperCase()) || UNKNOWN_CLASS);

/** Does this person hold a current, verified professional credential of one of these roles? */
function credentialOk(user, business, roles) {
  if (business?.pharmacySettings?.requireDispenserCredential === false) return true;
  const c = user?.pharmacyCredential;
  if (!c || !roles.includes(c.role) || !c.verifiedAt) return false;
  return !c.expiresAt || new Date(c.expiresAt) > new Date();
}

const asNum = (n) => Math.round(n * 1000) / 1000;
const remaining = (pi) => asNum(pi.prescribedQty - (pi.dispensedQty || 0));

/**
 * Checks a sale's lines against pharmacy rules. Returns null when the business is not running dispensing; otherwise
 * { prescription, dispensed: [{ item, presItemId, qty }], dispenser }  (dispensed is empty for a plain OTC sale).
 * `items`: [{ productId, nameSnapshot, baseQuantity }]
 */
async function assess({ business, businessId, user, items, prescriptionId, poisonsBook, countersign, session }) {
  if (!isOn(business)) { if (prescriptionId) throw ApiError.badRequest('Prescriptions are not enabled for this business', 'FEATURE_DISABLED'); return null; }
  const classes = classesOf(business);
  const q = MedicineDetails.find({ businessId, productId: { $in: items.map((i) => i.productId) } });
  const details = await (session ? q.session(session) : q);
  const byProduct = new Map(details.map((d) => [String(d.productId), d]));

  let needsDispenser = false; let needsRestricted = false; let needsRx = false; const poisonItems = [];
  const rxProducts = new Set();
  for (const it of items) {
    const d = byProduct.get(String(it.productId));
    if (d && ['recalled', 'quarantined'].includes(d.status)) throw ApiError.conflict(`${it.nameSnapshot} is ${d.status}${d.statusReason ? ` (${d.statusReason})` : ''} and cannot be sold`, 'MEDICINE_BLOCKED');
    const cls = classFor(classes, d);
    if (cls.requiresPrescription) { needsRx = true; rxProducts.add(String(it.productId)); }
    if (cls.requiresPrescription || cls.dispenserOnly || cls.restricted) needsDispenser = true;
    if (cls.restricted) needsRestricted = true;
    if (cls.poisonsBook) poisonItems.push({ it, d });
    if (cls.maxQtyPerDispense > 0 && it.baseQuantity > cls.maxQtyPerDispense) {
      throw ApiError.badRequest(`${it.nameSnapshot}: at most ${cls.maxQtyPerDispense} may be dispensed at once`, 'QUANTITY_LIMIT', [{ max: cls.maxQtyPerDispense }]);
    }
  }

  if (needsDispenser) {
    if (!hasPermission(user, 'pharmacy.dispense')) throw ApiError.forbidden('Only an authorised dispenser can sell these medicines', 'DISPENSER_REQUIRED');
    if (needsRestricted && !hasPermission(user, 'pharmacy.restricted')) throw ApiError.forbidden('You are not authorised to sell restricted medicines', 'RESTRICTED_NOT_AUTHORISED');
    const roles = needsRestricted ? ['PHARMACIST'] : ['PHARMACIST', 'DISPENSER'];
    if (!credentialOk(user, business, roles)) throw ApiError.forbidden(`This sale needs a verified ${roles.join(' or ').toLowerCase()} credential on your account`, 'CREDENTIAL_REQUIRED');
  }

  if (needsRestricted && rulesOf(business).requireCountersign && !(countersign && countersign.signed === true && countersign.name)) {
    throw ApiError.badRequest('The patient or their representative must countersign when a controlled drug is dispensed. Record their name and signature.', 'COUNTERSIGN_REQUIRED');
  }

  if (!prescriptionId) {
    if (needsRx) throw ApiError.badRequest('A validated prescription is required for one or more of these medicines', 'PRESCRIPTION_REQUIRED');
    if (poisonItems.length) {
      if (!poisonsBook || !poisonsBook.purchaserName || !poisonsBook.purchaserAddress || !poisonsBook.purpose || poisonsBook.signed !== true) throw ApiError.badRequest('This is a Part I poison sold without a prescription. The Poisons Book needs the purchaser\'s name, address, purpose and signature.', 'POISONS_BOOK_REQUIRED');
      return { prescription: null, dispensed: [], dispenser: { name: user.name, role: user.pharmacyCredential?.role, registrationNumber: user.pharmacyCredential?.registrationNumber }, poisons: { items: poisonItems.map(({ it, d }) => ({ it, strength: d?.strength, dosageForm: d?.dosageForm })), purchaser: { name: poisonsBook.purchaserName, address: poisonsBook.purchaserAddress, idNumber: poisonsBook.idNumber, purpose: poisonsBook.purpose, signed: true } } };
    }
    return { prescription: null, dispensed: [], dispenser: null };
  }

  const pq = Prescription.findOne({ _id: prescriptionId, businessId });
  const rx = await (session ? pq.session(session) : pq);
  if (!rx) throw ApiError.badRequest('Prescription not found', 'PRESCRIPTION_NOT_FOUND');
  if (!['VALIDATED', 'PARTIALLY_DISPENSED'].includes(rx.status)) throw ApiError.conflict(`This prescription is ${rx.status}. Only a validated prescription can be dispensed.`, 'PRESCRIPTION_NOT_VALID');
  if (new Date(rx.validUntil) < new Date()) throw ApiError.conflict('This prescription has expired', 'PRESCRIPTION_EXPIRED');
  if (!credentialOk(user, business, ['PHARMACIST', 'DISPENSER'])) throw ApiError.forbidden('Dispensing needs a verified pharmacist or dispenser credential', 'CREDENTIAL_REQUIRED');
  if (!hasPermission(user, 'pharmacy.dispense')) throw ApiError.forbidden('Only an authorised dispenser can dispense a prescription', 'DISPENSER_REQUIRED');
  const pq2 = Patient.findOne({ _id: rx.patientId, businessId, status: 'active' });
  if (!(await (session ? pq2.session(session) : pq2))) throw ApiError.conflict('The patient record for this prescription is not available', 'PATIENT_NOT_AVAILABLE');

  // Repeat control: how many times, and how often, this prescription may be dispensed.
  if (rx.maxDispensings || rx.minIntervalDays) {
    const dq = DispensingRecord.find({ businessId, prescriptionId: rx._id, status: 'DISPENSED' }).sort({ createdAt: -1 });
    const done = await (session ? dq.session(session) : dq);
    if (rx.maxDispensings && done.length >= rx.maxDispensings) throw ApiError.conflict(`This prescription allows ${rx.maxDispensings} dispensing(s) and they have all been made`, 'REPEAT_LIMIT');
    if (rx.minIntervalDays && done.length) {
      const next = new Date(new Date(done[0].createdAt).getTime() + rx.minIntervalDays * 86400000);
      if (next > new Date()) throw ApiError.conflict(`Too soon: this prescription can next be dispensed on ${next.toISOString().slice(0, 10)}`, 'TOO_SOON', [{ nextDate: next }]);
    }
  }

  // Lines of the same product add up against the prescription's remaining quantity.
  const want = new Map();
  const dispensed = [];
  for (const it of items) {
    const pi = rx.items.find((x) => String(x.productId) === String(it.productId));
    if (!pi) {
      if (rxProducts.has(String(it.productId))) throw ApiError.badRequest(`${it.nameSnapshot} is not on this prescription`, 'NOT_ON_PRESCRIPTION');
      continue; // an ordinary item bought at the same time
    }
    const k = String(pi._id); want.set(k, asNum((want.get(k) || 0) + it.baseQuantity));
    dispensed.push({ item: it, presItemId: pi._id, qty: it.baseQuantity });
  }
  if (!dispensed.length) throw ApiError.badRequest('None of the items on this sale are on the prescription', 'PRESCRIPTION_NOT_USED');
  for (const [k, qty] of want) {
    const pi = rx.items.find((x) => String(x._id) === k);
    if (qty > remaining(pi)) throw ApiError.badRequest(`${pi.nameSnapshot}: only ${remaining(pi)} left on this prescription`, 'EXCEEDS_PRESCRIBED', [{ remaining: remaining(pi) }]);
  }
  return { prescription: rx, dispensed, countersign: needsRestricted && countersign ? { name: countersign.name, relationship: countersign.relationship, at: new Date() } : undefined, dispenser: { name: user.name, role: user.pharmacyCredential?.role, registrationNumber: user.pharmacyCredential?.registrationNumber } };
}

/** Inside the sale's transaction: write the dispensing record and burn down the prescription. Re-checks the quantities. */
async function recordWithinSale({ ctx, sale, user, allocByItem, session }) {
  if (ctx && ctx.poisons && !ctx.prescription) {
    const seq = await nextSequence(sale.businessId, 'poisonsbook:business', session);
    const [entry] = await PoisonsBookEntry.create([{
      businessId: sale.businessId, branchId: sale.branchId, number: `PB-${pad(seq)}`, saleId: sale._id, purchaser: ctx.poisons.purchaser, dispenserId: user._id, dispenserSnapshot: ctx.dispenser,
      items: ctx.poisons.items.map(({ it, strength, dosageForm }) => ({ productId: it.productId, nameSnapshot: it.nameSnapshot, strength, dosageForm, quantity: it.baseQuantity, batches: (allocByItem.get(it) || []).map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber, quantity: b.quantity })) })),
    }], { session });
    await Sale.updateOne({ _id: sale._id }, { $set: { poisonsBookId: entry._id } }, { session });
    sale.poisonsBookId = entry._id;
    await AuditLog.create([{ businessId: sale.businessId, branchId: sale.branchId, userId: user._id, action: 'poisonsbook.create', entityType: 'PoisonsBookEntry', entityId: entry._id, newValue: { number: entry.number, saleId: sale._id } }], { session });
    return entry;
  }
  if (!ctx || !ctx.prescription || !ctx.dispensed.length) return null;
  const rx = await Prescription.findOne({ _id: ctx.prescription._id, businessId: sale.businessId }).session(session);
  if (!rx || !['VALIDATED', 'PARTIALLY_DISPENSED'].includes(rx.status)) throw ApiError.conflict('The prescription changed while the sale was being made', 'PRESCRIPTION_NOT_VALID');

  const grouped = new Map();
  for (const d of ctx.dispensed) {
    const k = String(d.presItemId);
    const g = grouped.get(k) || { qty: 0, batches: [] };
    g.qty = asNum(g.qty + d.qty); g.batches.push(...(allocByItem.get(d.item) || []));
    grouped.set(k, g);
  }
  const lines = [];
  for (const [k, g] of grouped) {
    const pi = rx.items.id ? rx.items.id(k) : rx.items.find((x) => String(x._id) === k);
    if (g.qty > remaining(pi)) throw ApiError.badRequest(`${pi.nameSnapshot}: only ${remaining(pi)} left on this prescription`, 'EXCEEDS_PRESCRIBED');
    pi.dispensedQty = asNum((pi.dispensedQty || 0) + g.qty);
    lines.push({
      productId: pi.productId, nameSnapshot: pi.nameSnapshot, strength: pi.strength, dosageForm: pi.dosageForm, quantity: g.qty, directions: pi.directions,
      batchAllocations: g.batches.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: b.quantity })),
    });
  }
  const seq = await nextSequence(sale.businessId, 'dispensing:business', session);
  const [rec] = await DispensingRecord.create([{
    businessId: sale.businessId, branchId: sale.branchId, number: `DSP-${pad(seq)}`, prescriptionId: rx._id, patientId: rx.patientId, saleId: sale._id,
    dispenserId: user._id, dispenserSnapshot: ctx.dispenser, items: lines, labelPrints: [], countersign: ctx.countersign,
  }], { session });
  rx.dispensingIds.push(rec._id);
  rx.status = rx.items.every((x) => remaining(x) <= 0) ? 'DISPENSED' : 'PARTIALLY_DISPENSED';
  await rx.save({ session });
  await Sale.updateOne({ _id: sale._id }, { $set: { prescriptionId: rx._id, dispensingId: rec._id } }, { session });
  sale.prescriptionId = rx._id; sale.dispensingId = rec._id;
  await AuditLog.create([{ businessId: sale.businessId, branchId: sale.branchId, userId: user._id, action: 'dispensing.create', entityType: 'DispensingRecord', entityId: rec._id, newValue: { number: rec.number, prescription: rx.number, saleId: sale._id } }], { session });
  return rec;
}

/** Flags for a sale an offline till already made: restricted medicines must have been dispensed online, so they are escalated to review. */
async function offlineFlags(business, products) {
  if (!isOn(business)) return [];
  const classes = classesOf(business);
  const details = await MedicineDetails.find({ businessId: business._id, productId: { $in: products.map((p) => p._id) } });
  const byProduct = new Map(details.map((d) => [String(d.productId), d]));
  const out = []; let anyMedicine = false;
  for (const p of products) {
    const d = byProduct.get(String(p._id));
    if (!d) continue;
    anyMedicine = true;
    const cls = classFor(classes, d);
    if (cls.requiresPrescription || cls.dispenserOnly || cls.restricted) out.push({ code: 'RESTRICTED_SOLD_OFFLINE', level: 'HIGH', message: `${p.name} (${cls.code}) was sold offline. Prescription and dispenser checks could not run.` });
  }
  if (anyMedicine && business.pharmacySettings?.allowOfflineOtc !== true && !out.length) out.push({ code: 'PHARMACY_OFFLINE_NOT_ALLOWED', level: 'HIGH', message: 'Medicines were sold offline but offline medicine sales are switched off for this pharmacy.' });
  return out;
}

module.exports = { isOn, classesOf, classFor, credentialOk, assess, recordWithinSale, offlineFlags, remaining };