/**
 * utils/barcode.js - ONE place that decides what a barcode is and whether it is really taken.
 *
 * THE BUG THIS FIXES: archiving ("deleting") a product only set status='archived'. The barcode stayed in the
 * unique index { businessId, barcode }, so the barcode was still "taken" by a product nobody can see. Creating a
 * new product with it failed with "barcode already exists" although the product is not in the system.
 *
 * RULES NOW
 *   - A barcode belongs only to a NON-archived product / variant / pack-unit.
 *   - Archived records give their barcode up (it moves to `archivedBarcode`, so it can be restored later if free).
 *   - Empty / whitespace barcodes are "no barcode" (never stored as "", which used to clash between products).
 */
const mongoose = require('mongoose');

/** Trim, drop control characters (scanner CR/LF/TAB). Returns undefined for "no barcode". */
function normalizeBarcode(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return s === '' ? undefined : s;
}

const uniq = (codes) => [...new Set((codes || []).map(normalizeBarcode).filter(Boolean))];
const withSession = (q, session) => (session ? q.session(session) : q);

/**
 * Archived products / variants that still hold one of these barcodes give them up.
 * Safe to call any time: it only touches ARCHIVED records.
 */
async function releaseArchivedBarcodes(businessId, codes, session) {
  const list = uniq(codes);
  if (!list.length) return 0;
  let released = 0;
  for (const name of ['Product', 'ProductVariant']) {
    const M = mongoose.model(name);
    const rows = await withSession(M.find({ businessId, status: 'archived', barcode: { $in: list } }).select('_id barcode').lean(), session);
    for (const r of rows) {
      await M.updateOne({ _id: r._id }, { $set: { archivedBarcode: r.barcode }, $unset: { barcode: 1 } }, session ? { session } : {});
      released += 1;
    }
  }
  return released;
}

/**
 * Who REALLY owns this barcode right now? Looks at live (non-archived) products, their pack units and variants.
 * Returns null when nobody does.  excludeProductId / excludeVariantId = the record being edited.
 */
async function findBarcodeOwner(businessId, barcode, { excludeProductId, excludeVariantId, session } = {}) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;
  const Product = mongoose.model('Product');
  const Variant = mongoose.model('ProductVariant');
  const notP = excludeProductId ? { _id: { $ne: excludeProductId } } : {};
  const notV = excludeVariantId ? { _id: { $ne: excludeVariantId } } : {};
  const live = { businessId, status: { $ne: 'archived' } };

  const [prod, unitProd, variant] = await Promise.all([
    withSession(Product.findOne({ ...live, ...notP, barcode: code }).select('name sku barcode').lean(), session),
    withSession(Product.findOne({ ...live, ...notP, units: { $elemMatch: { barcode: code } } }).select('name sku').lean(), session),
    withSession(Variant.findOne({ ...live, ...notV, barcode: code }).select('productId sku').lean(), session),
  ]);
  if (prod) return { kind: 'product', productId: String(prod._id), name: prod.name, sku: prod.sku };
  if (unitProd) return { kind: 'pack', productId: String(unitProd._id), name: unitProd.name, sku: unitProd.sku };
  if (variant) {
    const parent = await withSession(Product.findOne({ _id: variant.productId, businessId, status: { $ne: 'archived' } }).select('name sku').lean(), session);
    if (parent) {
      return { kind: 'variant', productId: String(parent._id), variantId: String(variant._id), name: parent.name, sku: variant.sku };
    }
  }
  return null;
}

module.exports = { normalizeBarcode, releaseArchivedBarcodes, findBarcodeOwner };
