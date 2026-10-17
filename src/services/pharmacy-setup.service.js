/**
 * Getting a pharmacy ready: a readiness check, bulk set-up of existing products as medicines, and a CSV template of the products
 * that still need medicine details. Credentials stay a human step: a person with authority verifies each registration.
 */
const Product = require('../models/Product');
const MedicineDetails = require('../models/MedicineDetails');
const Business = require('../models/Business');
const User = require('../models/User');
const Supplier = require('../models/Supplier');
const AuditLog = require('../models/AuditLog');
const medicines = require('./medicine.service');
const guard = require('./pharmacy-guard.service');
const supplierSvc = require('./pharmacy-supplier.service');
const extras = require('./pharmacy-extras.service');
const { hasPermission } = require('../utils/permissionCheck');
const ApiError = require('../utils/ApiError');

async function status(businessId) {
  const business = await Business.findById(businessId);
  const view = await medicines.getSettings(businessId);
  const [products, withDetails, staff, suppliers] = await Promise.all([
    Product.countDocuments({ businessId, status: 'active', productType: { $ne: 'service' } }),
    MedicineDetails.countDocuments({ businessId }),
    User.find({ businessId, status: 'active' }).select('name role grantedPermissions revokedPermissions pharmacyCredential'),
    Supplier.find({ businessId, status: 'active' }).select('name pharmacyApproval'),
  ]);
  const now = new Date(); const live = (u) => u.pharmacyCredential && u.pharmacyCredential.verifiedAt && (!u.pharmacyCredential.expiresAt || new Date(u.pharmacyCredential.expiresAt) > now);
  const dispensers = staff.filter((u) => hasPermission(u, 'pharmacy.dispense'));
  const noCred = dispensers.filter((u) => !live(u));
  const hasPharmacist = staff.some((u) => u.pharmacyCredential?.role === 'PHARMACIST' && live(u));
  const unapproved = suppliers.filter((s) => supplierSvc.approvalState(s) !== 'APPROVED');
  const checks = [
    { key: 'classes', ok: view.classesConfirmed, blocker: true, message: view.classesConfirmed ? 'A pharmacist has confirmed the medicine classes.' : `The medicine classes are the ${view.country} starting points and have not been confirmed by a pharmacist. Review them against the regulator's current lists, then confirm.` },
    { key: 'pharmacist', ok: hasPharmacist, blocker: true, message: hasPharmacist ? 'A pharmacist with a verified credential is on the team.' : 'No staff member has a verified pharmacist credential. Prescriptions cannot be reviewed and controlled drugs cannot be sold.' },
    { key: 'dispensers', ok: noCred.length === 0, blocker: false, message: noCred.length ? `${noCred.length} staff member(s) can dispense but have no current verified credential: ${noCred.map((u) => u.name).join(', ')}.` : 'Everyone who can dispense has a current credential.' },
    { key: 'medicines', ok: withDetails > 0 && withDetails >= products * 0 , blocker: true, message: withDetails ? `${withDetails} product(s) are set up as medicines; ${Math.max(0, products - withDetails)} other active product(s) are treated as non-medicines.` : 'No product is set up as a medicine yet. Use the template and bulk import.' },
    { key: 'rooms', ok: (view.rooms || []).length > 0, blocker: false, message: (view.rooms || []).length ? 'Storage places are defined.' : 'No storage places (room, fridge) with temperature ranges are defined, so temperature logging has no limits.' },
    { key: 'suppliers', ok: !unapproved.length || view.requireApprovedSuppliers === false, blocker: false, message: unapproved.length ? `${unapproved.length} supplier(s) have no current licence on file, so medicines cannot be bought from them yet.` : 'All suppliers have a current licence on file.' },
  ];
  return { ready: checks.filter((c) => c.blocker).every((c) => c.ok), country: view.country, regulator: view.regulator, checks, counts: { products, medicines: withDetails, dispensersWithoutCredential: noCred.length, unapprovedSuppliers: unapproved.length } };
}

const needle = (s) => String(s || '').trim();
/** items: [{ productId | sku | barcode, genericName, strength, dosageForm, classification?, ... }]. dryRun validates without writing. */
async function bulkImport(businessId, user, { items, dryRun }) {
  const business = await Business.findById(businessId).select('pharmacySettings countryCode');
  const classes = guard.classesOf(business);
  const results = []; let ok = 0;
  for (const [i, it] of items.entries()) {
    const row = { row: i + 1, ref: it.productId || it.sku || it.barcode };
    try {
      const q = { businessId }; if (it.productId) q._id = it.productId; else if (it.sku) q.sku = needle(it.sku); else if (it.barcode) q.barcode = needle(it.barcode); else throw ApiError.badRequest('Give productId, sku or barcode', 'NO_PRODUCT_REF');
      const product = await Product.findOne(q).select('_id name productType');
      if (!product) throw ApiError.badRequest('No product matches', 'PRODUCT_NOT_FOUND');
      if (product.productType === 'service') throw ApiError.badRequest('A service cannot be a medicine', 'NOT_A_MEDICINE');
      const cls = String(it.classification || 'OTC').toUpperCase();
      if (!classes.has(cls)) throw ApiError.badRequest(`Unknown class "${cls}"`, 'UNKNOWN_CLASS');
      if (!dryRun) { const { productId, sku, barcode, ...fields } = it; await medicines.upsert(businessId, user, product._id, { ...fields, classification: cls }); }
      row.productId = product._id; row.name = product.name; row.ok = true; ok += 1;
    } catch (e) { row.ok = false; row.error = e.message; row.code = e.code; }
    results.push(row);
  }
  if (!dryRun) await AuditLog.create({ businessId, userId: user._id, action: 'medicine.bulk', entityType: 'MedicineDetails', newValue: { rows: items.length, ok } });
  return { dryRun: !!dryRun, total: items.length, ok, failed: items.length - ok, results };
}

/** CSV of active products that are not yet medicines, with the columns to fill in. */
async function template(businessId) {
  const have = new Set((await MedicineDetails.find({ businessId }).select('productId')).map((m) => String(m.productId)));
  const prods = (await Product.find({ businessId, status: 'active', productType: { $ne: 'service' } }).select('sku barcode name').sort({ name: 1 }).limit(20000)).filter((p) => !have.has(String(p._id)));
  return { filename: 'medicines-setup.csv', csv: extras.toCsv(['sku', 'barcode', 'name', 'genericName', 'strength', 'dosageForm', 'classification', 'brandName', 'manufacturer', 'registrationNumber'], prods.map((p) => [p.sku, p.barcode, p.name, '', '', '', 'OTC', '', '', ''])) };
}

module.exports = { status, bulkImport, template };