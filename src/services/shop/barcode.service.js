/** Internal barcodes (EAN-13, prefix 2 = "in-store use") for goods that arrive without one, plus shelf-label data. */
const Product = require('../../models/Product');
const { nextSequence } = require('../../models/Counter');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');

function ean13Check(d12) {
  let s = 0; for (let i = 0; i < 12; i += 1) s += Number(d12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (s % 10)) % 10);
}
const isValidEan13 = (c) => /^\d{13}$/.test(c) && ean13Check(c.slice(0, 12)) === c[12];
/** 2 + 10-digit running number (+ check digit). The number is per business so two shops never clash inside their own data. */
const buildInternal = (seq) => { const d12 = `2${String(seq).padStart(11, '0')}`; return d12 + ean13Check(d12); };

async function generate(businessId, user, { productIds, categoryId, limit = 500 } = {}) {
  const q = { businessId, status: 'active', $or: [{ barcode: { $exists: false } }, { barcode: null }, { barcode: '' }] };
  if (productIds?.length) q._id = { $in: productIds };
  if (categoryId) q.categoryId = categoryId;
  const products = await Product.find(q).select('name sku').limit(limit);
  const out = [];
  for (const p of products) {
    for (let tries = 0; tries < 5; tries += 1) {
      const code = buildInternal(await nextSequence(businessId, 'barcode:internal'));
      try { const r = await Product.updateOne({ _id: p._id, businessId, $or: [{ barcode: { $exists: false } }, { barcode: null }, { barcode: '' }] }, { $set: { barcode: code, updatedBy: user._id } }); if (r.modifiedCount) out.push({ productId: p._id, name: p.name, barcode: code }); break; }
      catch (e) { if (e.code !== 11000) throw e; }
    }
  }
  return { generated: out.length, remainingWithout: await Product.countDocuments({ ...q, ...(limit ? {} : {}) }), items: out };
}

async function labels(businessId, { productIds, copies = 1 }) {
  if (!productIds?.length) throw ApiError.badRequest('Pick at least one product', 'NO_SELECTION');
  const ps = await Product.find({ _id: { $in: productIds }, businessId }).select('name sku barcode sellingPrice unit').lean();
  return ps.map((p) => ({ productId: p._id, name: p.name, sku: p.sku, barcode: p.barcode || null, barcodeType: p.barcode && /^\d{13}$/.test(p.barcode) ? 'EAN13' : 'CODE128', price: fromCents(p.sellingPrice), unit: p.unit, copies, printable: !!p.barcode }));
}
module.exports = { ean13Check, isValidEan13, buildInternal, generate, labels };
