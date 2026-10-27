/**
 * Product spreadsheet import / export.
 *  - Accepts CSV text (any of , ; tab) or rows already parsed by the app from an Excel file.
 *  - Always run with dryRun first: every row is validated and reported, nothing is written.
 *  - Rows are independent: a bad row never blocks the good ones. Re-running the same file is safe (existing SKU / barcode is skipped or updated).
 *  - Opening stock is only ever added to a NEW product (an existing product's stock is changed by purchases, adjustments or a stocktake).
 */
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const PriceChangeBatch = require('../../models/PriceChangeBatch');
const BranchInventory = require('../../models/BranchInventory');
const AuditLog = require('../../models/AuditLog');
const { nextSequence, pad } = require('../../models/Counter');
const productSvc = require('../product.service');
const inventory = require('../inventory.service');
const { parseCsv, toCsv } = require('../../utils/csv');
const { toCents, fromCents } = require('../../utils/money');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { IMPORT_COLUMNS, IMPORT_MAX_ROWS } = require('../../constants/shop');
const ApiError = require('../../utils/ApiError');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIAS = new Map();
for (const c of IMPORT_COLUMNS) { ALIAS.set(norm(c.key), c.key); ALIAS.set(norm(c.label), c.key); for (const a of c.aliases || []) ALIAS.set(norm(a), c.key); }
const UNIT_ALIAS = { pcs: 'piece', pc: 'piece', pieces: 'piece', each: 'piece', ea: 'piece', kgs: 'kg', kilo: 'kg', kilos: 'kg', gram: 'g', grams: 'g', ltr: 'litre', ltrs: 'litre', l: 'litre', liter: 'litre', liters: 'litre', litres: 'litre', pkt: 'packet', pkts: 'packet', packets: 'packet', btl: 'bottle', bottles: 'bottle', ctn: 'carton', cartons: 'carton', boxes: 'box', bags: 'bag', sacks: 'sack', tins: 'tin', dozens: 'dozen', pairs: 'pair', sets: 'set', rolls: 'roll', m: 'metre', meter: 'metre', metres: 'metre', meters: 'metre' };

function mapHeaders(headers) {
  const map = {}; const unknown = [];
  headers.forEach((h, i) => { const k = ALIAS.get(norm(h)); if (k && map[k] === undefined) map[k] = i; else if (String(h).trim()) unknown.push(String(h).trim()); });
  const missing = IMPORT_COLUMNS.filter((c) => c.required && map[c.key] === undefined).map((c) => c.label);
  return { map, unknown, missing };
}

function template() {
  const head = IMPORT_COLUMNS.map((c) => c.label);
  const rows = [head,
    ['Fresh Milk 500ml', 'MILK-500', '6161101234567', 'Dairy', 'Brookside', 'piece', '48', '65', '0', '10', '24', 'Long life milk', ''],
    ['Sugar 1kg', '', '', 'Groceries', '', 'kg', '150', '190', '0', '20', '50', '', '']];
  return toCsv(rows);
}

function money(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { blank: true };
  const s = String(v).replace(/(kes|ksh|tzs|tsh|usd)/ig, '').replace(/[,\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? { cents: toCents(n) } : { error: true };
}

/** Turn the raw table into normalised row objects (no database access). */
function normaliseRows({ csv, rows }) {
  let table;
  if (csv) table = parseCsv(csv);
  else if (Array.isArray(rows) && rows.length) {
    if (Array.isArray(rows[0])) table = rows.map((r) => r.map((x) => (x == null ? '' : String(x))));
    else { const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]; table = [keys, ...rows.map((r) => keys.map((k) => (r[k] == null ? '' : String(r[k]))))]; }
  } else throw ApiError.badRequest('Send the file contents as csv text or as rows', 'NO_IMPORT_DATA');
  if (table.length < 2) throw ApiError.badRequest('The file has no data rows', 'EMPTY_IMPORT');
  const { map, unknown, missing } = mapHeaders(table[0]);
  if (missing.length) throw ApiError.badRequest(`Missing required column(s): ${missing.join(', ')}`, 'MISSING_COLUMNS');
  const body = table.slice(1);
  if (body.length > IMPORT_MAX_ROWS) throw ApiError.badRequest(`At most ${IMPORT_MAX_ROWS} rows per import. Split the file.`, 'TOO_MANY_ROWS');
  const get = (r, k) => (map[k] === undefined ? '' : String(r[map[k]] ?? '').trim());
  const out = body.map((r, i) => {
    const row = { row: i + 2, errors: [], warnings: [] };
    row.name = get(r, 'name').slice(0, 200);
    row.sku = get(r, 'sku').replace(/\s+/g, '').toUpperCase().slice(0, 40);
    row.barcode = get(r, 'barcode').replace(/\s+/g, '').slice(0, 40);
    if (/e\+/i.test(row.barcode)) row.errors.push('Barcode looks like scientific notation (Excel damaged it). Format the column as Text and re-export.');
    row.category = get(r, 'category').slice(0, 80);
    row.brand = get(r, 'brand').slice(0, 80);
    row.description = get(r, 'description').slice(0, 1000);
    row.image = get(r, 'image');
    if (row.image && !/^https?:\/\//i.test(row.image)) { row.warnings.push('Image must be a web link (https://...). Ignored.'); row.image = ''; }
    const u = get(r, 'unit').toLowerCase();
    row.unit = !u ? 'piece' : (Product.UNITS.includes(u) ? u : UNIT_ALIAS[u]);
    if (!row.unit) { row.warnings.push(`Unknown unit "${u}", using piece`); row.unit = 'piece'; }
    const sp = money(get(r, 'sellingPrice')); const cp = money(get(r, 'costPrice'));
    if (sp.error || sp.blank) row.errors.push('Selling price is missing or not a number'); else row.sellingPrice = sp.cents;
    if (cp.error) row.errors.push('Cost price is not a number'); else row.costPrice = cp.blank ? undefined : cp.cents;
    const tax = get(r, 'taxRate'); if (tax !== '') { const t = Number(tax.replace('%', '')); if (!Number.isFinite(t) || t < 0 || t > 100) row.errors.push('Tax rate must be 0 to 100'); else row.taxRate = t; }
    const low = get(r, 'lowStockThreshold'); if (low !== '') { const n = Number(low); if (!Number.isFinite(n) || n < 0) row.errors.push('Reorder level must be 0 or more'); else row.lowStockThreshold = n; }
    const st = get(r, 'openingStock'); if (st !== '') { const n = Number(st.replace(/,/g, '')); if (!Number.isFinite(n) || n < 0) row.errors.push('Opening stock must be 0 or more'); else row.openingStock = n; }
    if (!row.name) row.errors.push('Name is missing');
    if (row.sellingPrice != null && row.costPrice != null && row.sellingPrice < row.costPrice) row.warnings.push('Selling price is below cost price');
    return row;
  });
  const seenSku = new Map(); const seenBar = new Map();
  for (const r of out) {
    if (r.sku) { if (seenSku.has(r.sku)) r.errors.push(`Duplicate SKU in file (also row ${seenSku.get(r.sku)})`); else seenSku.set(r.sku, r.row); }
    if (r.barcode) { if (seenBar.has(r.barcode)) r.errors.push(`Duplicate barcode in file (also row ${seenBar.get(r.barcode)})`); else seenBar.set(r.barcode, r.row); }
  }
  return { rows: out, unknownColumns: unknown };
}

async function nextSku(businessId) {
  for (let i = 0; i < 20; i += 1) {
    const sku = `SKU-${pad(await nextSequence(businessId, 'sku:business'), 6)}`;
    if (!(await Product.exists({ businessId, sku }))) return sku;
  }
  throw ApiError.internal('Could not allocate a SKU');
}

async function run(businessId, user, { csv, rows, dryRun = true, mode = 'CREATE_ONLY', branchId, createCategories = true, defaultTaxRate = 0 }) {
  const { rows: list, unknownColumns } = normaliseRows({ csv, rows });
  const wantsStock = list.some((r) => r.openingStock > 0);
  if (!dryRun && wantsStock) { if (!branchId) throw ApiError.badRequest('Pick the branch that holds the opening stock', 'BRANCH_REQUIRED'); assertBranchAccess(user, branchId); }

  const skus = list.map((r) => r.sku).filter(Boolean); const bars = list.map((r) => r.barcode).filter(Boolean);
  const existing = await Product.find({ businessId, $or: [{ sku: { $in: skus } }, { barcode: { $in: bars } }] }).select('sku barcode name hasVariants sellingPrice costPrice');
  const bySku = new Map(existing.map((p) => [p.sku, p])); const byBar = new Map(existing.filter((p) => p.barcode).map((p) => [p.barcode, p]));

  const catNames = [...new Set(list.map((r) => r.category).filter(Boolean))];
  const cats = await Category.find({ businessId, status: 'active' }).select('name');
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c]));

  const results = []; const summary = { total: list.length, created: 0, updated: 0, skipped: 0, failed: 0, categoriesCreated: 0, stockLines: 0 };
  const priceItems = { sellingPrice: [], costPrice: [] };
  for (const r of list) {
    const res = { row: r.row, name: r.name, sku: r.sku || null, warnings: [...r.warnings] };
    if (r.errors.length) { res.status = 'ERROR'; res.errors = r.errors; summary.failed += 1; results.push(res); continue; }
    const found = (r.sku && bySku.get(r.sku)) || (r.barcode && byBar.get(r.barcode)) || null;
    if (r.sku && r.barcode && bySku.get(r.sku) && byBar.get(r.barcode) && String(bySku.get(r.sku)._id) !== String(byBar.get(r.barcode)._id)) {
      res.status = 'ERROR'; res.errors = ['SKU and barcode belong to two different existing products']; summary.failed += 1; results.push(res); continue;
    }
    try {
      let categoryId;
      if (r.category) {
        let c = catByName.get(r.category.toLowerCase());
        if (!c && createCategories) {
          if (!dryRun) { c = await Category.create({ businessId, name: r.category }); catByName.set(r.category.toLowerCase(), c); }
          else catByName.set(r.category.toLowerCase(), { _id: null, name: r.category, virtual: true });
          summary.categoriesCreated += 1; res.warnings.push(`Category "${r.category}" will be created`);
        } else if (!c) res.warnings.push(`Category "${r.category}" not found; left blank`);
        categoryId = c && c._id ? c._id : undefined;
      }
      if (found) {
        if (mode !== 'UPSERT') { res.status = 'SKIPPED'; res.reason = 'Already exists (switch to update mode to change it)'; summary.skipped += 1; results.push(res); continue; }
        const upd = { name: r.name, brand: r.brand || undefined, description: r.description || undefined, image: r.image || undefined, unit: r.unit, taxRate: r.taxRate, lowStockThreshold: r.lowStockThreshold, categoryId };
        if (!found.hasVariants) { upd.sellingPrice = r.sellingPrice; if (r.costPrice !== undefined) upd.costPrice = r.costPrice; } else res.warnings.push('Product has variants: prices not changed');
        Object.keys(upd).forEach((k) => upd[k] === undefined && delete upd[k]);
        if (!dryRun) {
          await productSvc.updateProduct(businessId, user._id, found._id, upd);
          if (upd.sellingPrice !== undefined && upd.sellingPrice !== found.sellingPrice) priceItems.sellingPrice.push({ productId: found._id, name: r.name, from: found.sellingPrice, to: upd.sellingPrice });
          if (upd.costPrice !== undefined && upd.costPrice !== found.costPrice) priceItems.costPrice.push({ productId: found._id, name: r.name, from: found.costPrice, to: upd.costPrice });
        }
        if (r.openingStock > 0) res.warnings.push('Opening stock ignored for an existing product (use a purchase, adjustment or stocktake)');
        res.status = 'UPDATED'; res.productId = found._id; summary.updated += 1; results.push(res); continue;
      }
      if (dryRun) { res.status = 'WILL_CREATE'; if (!r.sku) res.sku = '(auto)'; if (r.openingStock > 0) summary.stockLines += 1; summary.created += 1; results.push(res); continue; }
      const sku = r.sku || await nextSku(businessId);
      const data = { name: r.name, sku, barcode: r.barcode || undefined, brand: r.brand || undefined, description: r.description || undefined, image: r.image || undefined, unit: r.unit,
        costPrice: r.costPrice || 0, sellingPrice: r.sellingPrice, taxRate: r.taxRate != null ? r.taxRate : defaultTaxRate, lowStockThreshold: r.lowStockThreshold, categoryId, trackInventory: true };
      Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
      const product = await productSvc.createProduct(businessId, user._id, data);
      res.status = 'CREATED'; res.productId = product._id; res.sku = sku; summary.created += 1;
      if (r.openingStock > 0) {
        try {
          await inventory.receiveStock(businessId, branchId, user._id, { productId: product._id, quantity: r.openingStock, costPrice: r.costPrice || 0, reason: 'Opening stock (spreadsheet import)' });
          summary.stockLines += 1;
        } catch (e) { res.warnings.push(`Product created but opening stock failed: ${e.message}`); }
      }
      results.push(res);
    } catch (e) { res.status = 'ERROR'; res.errors = [e.message]; summary.failed += 1; results.push(res); }
  }
  if (!dryRun) {
    for (const field of ['sellingPrice', 'costPrice']) {
      if (priceItems[field].length) await PriceChangeBatch.create({ businessId, source: 'IMPORT', field, summary: `Spreadsheet import (${priceItems[field].length} products)`, items: priceItems[field], createdBy: user._id });
    }
    await AuditLog.create({ businessId, userId: user._id, action: 'product.import', entityType: 'Product', newValue: { mode, ...summary } });
  }
  return { dryRun, mode, summary, unknownColumns, results };
}

async function exportCsv(businessId, user, { branchId, categoryId } = {}) {
  if (branchId) assertBranchAccess(user, branchId);
  const filter = { businessId, status: 'active' }; if (categoryId) filter.categoryId = categoryId;
  const [products, cats, inv] = await Promise.all([
    Product.find(filter).sort({ name: 1 }).limit(20000).lean(),
    Category.find({ businessId }).select('name').lean(),
    BranchInventory.aggregate([{ $match: { businessId: user.businessId || businessId, ...(branchId ? { branchId: new (require('mongoose').Types.ObjectId)(String(branchId)) } : {}) } }, { $group: { _id: '$productId', qty: { $sum: '$quantity' } } }]),
  ]);
  const C = new Map(cats.map((c) => [String(c._id), c.name])); const I = new Map(inv.map((x) => [String(x._id), x.qty]));
  const head = [...IMPORT_COLUMNS.map((c) => c.label)];
  const rows = products.map((p) => [p.name, p.sku, p.barcode || '', C.get(String(p.categoryId)) || '', p.brand || '', p.unit, fromCents(p.costPrice), fromCents(p.sellingPrice), p.taxRate || 0, p.lowStockThreshold ?? '', I.get(String(p._id)) ?? 0, p.description || '', p.image || '']);
  return { csv: toCsv([head, ...rows]), count: rows.length };
}

module.exports = { template, normaliseRows, run, exportCsv };
