/** Product templates: owner-defined attributes per kind of product, plus barcode / tracking rules. No code change needed to add a category. */
const HardwareTemplate = require('../../models/HardwareTemplate');
const Product = require('../../models/Product');
const HardwareProfile = require('../../models/HardwareProfile');
const AuditLog = require('../../models/AuditLog');
const ApiError = require('../../utils/ApiError');

const T = (name, extra) => ({ name, ...extra });
const DEFAULTS = [
  T('Cement, sand and aggregates', { trackingMethod: 'BULK_CONVERSION', measurable: true, divisible: true, suggestedBaseUnit: 'kg', suggestedUnits: [{ name: 'bag (50 kg)', factor: 50 }, { name: 'tonne', factor: 1000 }], attributes: [{ key: 'grade', label: 'Grade', type: 'SELECT', options: ['32.5N', '42.5N', '52.5N', 'Coarse', 'Fine'] }, { key: 'source', label: 'Quarry / source', type: 'TEXT' }] }),
  T('Steel, timber and roofing', { trackingMethod: 'COUNT', measurable: true, divisible: false, suggestedBaseUnit: 'piece', attributes: [{ key: 'diameter', label: 'Diameter', type: 'NUMBER', unit: 'mm', variantAxis: true }, { key: 'length', label: 'Length', type: 'NUMBER', unit: 'm', variantAxis: true }, { key: 'thickness', label: 'Thickness / gauge', type: 'NUMBER', unit: 'mm', variantAxis: true }, { key: 'grade', label: 'Grade', type: 'TEXT' }, { key: 'finish', label: 'Finish / colour', type: 'TEXT' }] }),
  T('Electrical, plumbing and fittings', { trackingMethod: 'BULK_CONVERSION', measurable: true, divisible: true, suggestedBaseUnit: 'm', suggestedUnits: [{ name: 'roll (100 m)', factor: 100 }], attributes: [{ key: 'size', label: 'Size', type: 'TEXT', variantAxis: true }, { key: 'diameter', label: 'Diameter', type: 'NUMBER', unit: 'mm', variantAxis: true }, { key: 'pressure', label: 'Pressure rating', type: 'TEXT' }, { key: 'material', label: 'Material', type: 'SELECT', options: ['PVC', 'PPR', 'GI', 'Copper', 'HDPE'] }] }),
  T('Paint, tools, fasteners and accessories', { trackingMethod: 'BARCODE', measurable: false, divisible: false, suggestedBaseUnit: 'piece', attributes: [{ key: 'colour', label: 'Colour', type: 'TEXT', variantAxis: true }, { key: 'size', label: 'Size', type: 'TEXT', variantAxis: true }, { key: 'warrantyMonths', label: 'Warranty', type: 'NUMBER', unit: 'months' }, { key: 'serialTracked', label: 'Serial tracked', type: 'BOOLEAN' }] }),
];
async function list(businessId) { return HardwareTemplate.find({ businessId }).sort({ name: 1 }); }
async function seedDefaults(businessId, user) {
  let added = 0; for (const d of DEFAULTS) { const r = await HardwareTemplate.updateOne({ businessId, name: d.name }, { $setOnInsert: { ...d, businessId } }, { upsert: true }); if (r.upsertedCount) added++; }
  await AuditLog.create({ businessId, userId: user._id, action: 'hardware.template.seed', entityType: 'HardwareTemplate', newValue: { added } }); return { added, total: DEFAULTS.length };
}
function checkAttrKeys(attrs) { const k = (attrs || []).map((a) => a.key); if (new Set(k).size !== k.length) throw ApiError.badRequest('Two attributes share the same key', 'DUPLICATE_ATTRIBUTE'); }
async function save(businessId, user, id, input) {
  checkAttrKeys(input.attributes);
  const doc = id ? await HardwareTemplate.findOne({ _id: id, businessId }) : new HardwareTemplate({ businessId });
  if (!doc) throw ApiError.notFound('Template not found'); Object.assign(doc, input);
  try { await doc.save(); } catch (e) { if (e.code === 11000) throw ApiError.conflict('A template with this name exists', 'DUPLICATE_NAME'); throw e; }
  await AuditLog.create({ businessId, userId: user._id, action: id ? 'hardware.template.update' : 'hardware.template.create', entityType: 'HardwareTemplate', entityId: doc._id }); return doc;
}
async function remove(businessId, user, id) {
  if (await HardwareProfile.exists({ businessId, templateId: id })) throw ApiError.conflict('Products use this template. Deactivate it instead.', 'IN_USE');
  const d = await HardwareTemplate.findOneAndDelete({ _id: id, businessId }); if (!d) throw ApiError.notFound('Template not found'); return { removed: true };
}
/** pure: check supplied attribute values against a template's definitions. */
function validateAttributes(template, attributes = []) {
  const defs = new Map(template.attributes.map((a) => [a.key, a])); const out = []; const seen = new Set();
  for (const a of attributes) {
    const d = defs.get(a.key); if (!d) throw ApiError.badRequest(`"${a.key}" is not an attribute of ${template.name}`, 'UNKNOWN_ATTRIBUTE');
    if (seen.has(a.key)) throw ApiError.badRequest(`"${d.label}" appears twice`, 'DUPLICATE_ATTRIBUTE'); seen.add(a.key);
    let v = a.value;
    if (d.type === 'NUMBER') { v = Number(v); if (!Number.isFinite(v)) throw ApiError.badRequest(`${d.label} must be a number`, 'INVALID_ATTRIBUTE'); }
    if (d.type === 'BOOLEAN') v = v === true || v === 'true';
    if (d.type === 'SELECT' && d.options?.length && !d.options.includes(v)) throw ApiError.badRequest(`${d.label} must be one of: ${d.options.join(', ')}`, 'INVALID_ATTRIBUTE');
    out.push({ key: a.key, value: v });
  }
  for (const d of template.attributes) if (d.required && !seen.has(d.key)) throw ApiError.badRequest(`${d.label} is required`, 'ATTRIBUTE_REQUIRED');
  return out;
}
/** Barcode rules for a profile save: unique alternative codes, REQUIRED means a code exists, NON_STOCK means the product is not stock-tracked. */
async function checkProfileRules(businessId, productId, product, input, existing) {
  const alt = input.altBarcodes ?? existing?.altBarcodes ?? []; const rule = input.barcodeRule ?? existing?.barcodeRule ?? 'OPTIONAL'; const tm = input.trackingMethod ?? existing?.trackingMethod ?? 'COUNT';
  if (new Set(alt).size !== alt.length) throw ApiError.badRequest('An alternative barcode is listed twice', 'DUPLICATE_BARCODE');
  if (input.altBarcodes?.length) {
    const clash = await Product.findOne({ businessId, _id: { $ne: productId }, $or: [{ barcode: { $in: alt } }, { 'units.barcode': { $in: alt } }] }).select('name');
    if (clash) throw ApiError.conflict(`That barcode already belongs to ${clash.name}`, 'DUPLICATE_BARCODE');
    if (alt.includes(product.barcode)) throw ApiError.badRequest('That is already this product\'s main barcode', 'DUPLICATE_BARCODE');
    const other = await HardwareProfile.findOne({ businessId, productId: { $ne: productId }, altBarcodes: { $in: alt } }).populate('productId', 'name'); if (other) throw ApiError.conflict(`That barcode already belongs to ${other.productId?.name || 'another product'}`, 'DUPLICATE_BARCODE');
  }
  if (rule === 'REQUIRED' && !product.barcode && !alt.length) throw ApiError.badRequest('This product needs a barcode: add one to the product or as an alternative barcode', 'BARCODE_REQUIRED');
  if (rule === 'NONE' && (product.barcode || alt.length)) throw ApiError.badRequest('Barcode rule is "no barcode" but a code is set', 'BARCODE_NOT_ALLOWED');
  if (tm === 'NON_STOCK' && product.trackInventory !== false) throw ApiError.badRequest('Turn off stock tracking on the product before marking it a service / non-stock item', 'TRACKING_MISMATCH');
  if (tm !== 'NON_STOCK' && product.trackInventory === false && input.trackingMethod) throw ApiError.badRequest('This product is not stock-tracked. Use the non-stock method.', 'TRACKING_MISMATCH');
}
/** Scan or type any code: main barcode, a unit barcode (carton) or an alternative barcode. */
async function lookupBarcode(businessId, code) {
  let p = await Product.findOne({ businessId, status: 'active', $or: [{ barcode: code }, { 'units.barcode': code }] }).select('name sku unit units barcode sellingPrice');
  if (p) { const u = (p.units || []).find((x) => x.barcode === code); return { productId: p._id, name: p.name, unitName: u ? u.name : p.unit, unitFactor: u ? u.factor : 1, matchedOn: u ? 'UNIT' : 'BARCODE' }; }
  const prof = await HardwareProfile.findOne({ businessId, altBarcodes: code }).select('productId').lean();
  if (prof) { p = await Product.findOne({ _id: prof.productId, businessId, status: 'active' }).select('name unit'); if (p) return { productId: p._id, name: p.name, unitName: p.unit, unitFactor: 1, matchedOn: 'ALT_BARCODE' }; }
  throw ApiError.notFound('No product has this barcode', 'BARCODE_NOT_FOUND');
}
module.exports = { DEFAULTS, list, seedDefaults, save, remove, validateAttributes, checkProfileRules, lookupBarcode };
