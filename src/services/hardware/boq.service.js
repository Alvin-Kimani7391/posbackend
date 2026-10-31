/** Bill of quantities per project: what the job needs vs what was ordered / invoiced, estimated vs actual cost. Quantities compare in BASE units. Money = integer cents. */
const Boq = require('../../models/Boq');
const Project = require('../../models/Project');
const Product = require('../../models/Product');
const Quotation = require('../../models/Quotation');
const DeliveryOrder = require('../../models/DeliveryOrder');
const AuditLog = require('../../models/AuditLog');
const { fromCents, toCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');
const money = (c) => fromCents(Math.round(c || 0)); const r3 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- pure ----------
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim())) rows.push(row); row = []; cur = ''; } else cur += c; }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}
const csvCell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** pure: compare required vs ordered vs invoiced per product. all inputs in base units / cents. */
function compareLines(boqRows, orderedByProduct) {
  return boqRows.map((r) => { const o = orderedByProduct.get(String(r.productId)) || { ordered: 0, invoiced: 0, actualCost: 0 };
    return { ...r, ordered: r3(o.ordered), invoiced: r3(o.invoiced), remainingToOrder: r3(Math.max(0, r.required - o.ordered)), overOrdered: r3(Math.max(0, o.ordered - r.required)), remainingToInvoice: r3(Math.max(0, r.required - o.invoiced)), actualCost: o.actualCost, estCost: Math.round(r.required * r.estUnitCost), costVariance: o.actualCost - Math.round(o.invoiced * r.estUnitCost) }; });
}

async function resolveLines(businessId, lines) {
  const ids = lines.map((l) => l.productId).filter(Boolean);
  const P = new Map((await Product.find({ _id: { $in: ids }, businessId }).select('name unit units costPrice sellingPrice').lean()).map((p) => [String(p._id), p]));
  return lines.map((l) => {
    if (!l.productId) return { description: l.description, unitName: l.unitName, quantity: l.quantity, baseQuantity: l.quantity, estUnitCost: l.estUnitCost || 0, estUnitPrice: l.estUnitPrice || 0 };
    const p = P.get(String(l.productId)); if (!p) throw ApiError.badRequest('A BOQ product was not found', 'PRODUCT_NOT_FOUND');
    let factor = 1; const un = l.unitName || p.unit;
    if (String(un).toLowerCase() !== String(p.unit).toLowerCase()) { const u = (p.units || []).find((x) => x.name.toLowerCase() === String(un).toLowerCase()); if (!u) throw ApiError.badRequest(`${p.name} has no unit called ${un}`, 'UNIT_NOT_FOUND'); factor = u.factor; }
    return { productId: p._id, description: l.description || p.name, unitName: un, quantity: l.quantity, baseQuantity: r3(l.quantity * factor), estUnitCost: l.estUnitCost ?? p.costPrice, estUnitPrice: l.estUnitPrice ?? p.sellingPrice };
  });
}
async function save(businessId, user, projectId, { lines, mode = 'REPLACE' }) {
  if (!(await Project.exists({ _id: projectId, businessId }))) throw ApiError.notFound('Project not found');
  const resolved = await resolveLines(businessId, lines);
  const doc = (await Boq.findOne({ businessId, projectId })) || new Boq({ businessId, projectId });
  doc.lines = mode === 'APPEND' ? [...doc.lines, ...resolved] : resolved; doc.version = (doc.version || 0) + 1; doc.updatedBy = user._id; await doc.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'hardware.boq.save', entityType: 'Boq', entityId: doc._id, newValue: { lines: doc.lines.length, mode } }); return doc;
}
async function get(businessId, projectId) { return (await Boq.findOne({ businessId, projectId }).populate('lines.productId', 'name sku unit')) || { projectId, lines: [], version: 0 }; }

/** CSV columns: sku, description, unit, quantity, est_cost, est_price  (cost/price per the line unit, in shillings). Unmatched rows are kept as free-text lines and reported. */
async function importCsv(businessId, user, projectId, { csv, mode = 'REPLACE' }) {
  const rows = parseCsv(csv); if (rows.length < 2) throw ApiError.badRequest('The file has no rows', 'EMPTY');
  const head = rows[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, '')); const col = (n) => head.indexOf(n);
  const iq = col('quantity') >= 0 ? col('quantity') : col('qty'); if (iq < 0) throw ApiError.badRequest('A "quantity" column is required', 'NO_QUANTITY_COLUMN');
  const is = col('sku'); const id = col('description') >= 0 ? col('description') : col('name'); const iu = col('unit'); const ic = col('estcost'); const ip = col('estprice');
  if (rows.length > 2001) throw ApiError.badRequest('Import up to 2,000 lines at a time', 'TOO_MANY');
  const lines = []; const unmatched = []; const errors = [];
  for (let n = 1; n < rows.length; n++) {
    const r = rows[n]; const qty = Number(r[iq]); if (!(qty > 0)) { errors.push({ row: n + 1, error: 'Quantity must be more than 0' }); continue; }
    const sku = is >= 0 ? r[is] : ''; const desc = id >= 0 ? r[id] : '';
    let p = null; if (sku) p = await Product.findOne({ businessId, $or: [{ sku: new RegExp(`^${esc(sku)}$`, 'i') }, { barcode: sku }] }).select('_id name').lean();
    if (!p && desc) p = await Product.findOne({ businessId, name: new RegExp(`^${esc(desc)}$`, 'i') }).select('_id name').lean();
    const num = (i) => (i >= 0 && r[i] !== '' && Number.isFinite(Number(r[i])) ? toCents(Number(r[i])) : undefined);
    if (!p && !desc) { errors.push({ row: n + 1, error: 'No SKU match and no description' }); continue; }
    if (!p) unmatched.push({ row: n + 1, description: desc, sku });
    lines.push({ productId: p?._id, description: desc || p?.name, unitName: iu >= 0 ? r[iu] || undefined : undefined, quantity: qty, estUnitCost: num(ic), estUnitPrice: num(ip) });
  }
  if (!lines.length) throw ApiError.badRequest('No usable rows', 'NO_ROWS');
  let doc;
  try { doc = await save(businessId, user, projectId, { lines, mode }); } catch (e) { if (e.code === 'UNIT_NOT_FOUND') throw ApiError.badRequest(`${e.message}. Fix the unit column and import again.`, 'UNIT_NOT_FOUND'); throw e; }
  return { imported: doc.lines.length, unmatched, errors };
}
async function exportCsv(businessId, projectId) {
  const doc = await get(businessId, projectId); const out = [['sku', 'description', 'unit', 'quantity', 'est_cost', 'est_price'].join(',')];
  for (const l of doc.lines) { const p = l.productId && l.productId.name ? l.productId : null; out.push([p?.sku, l.description, l.unitName, l.quantity, l.estUnitCost ? fromCents(l.estUnitCost) : '', l.estUnitPrice ? fromCents(l.estUnitPrice) : ''].map(csvCell).join(',')); }
  return out.join('\n');
}
/** Required vs ordered vs invoiced, estimated vs actual cost, plus delivery progress. */
async function status(businessId, projectId) {
  const doc = await Boq.findOne({ businessId, projectId }).lean(); if (!doc) throw ApiError.notFound('This project has no BOQ yet');
  const quotes = await Quotation.find({ businessId, projectId, status: { $in: ['APPROVED', 'PARTIALLY_FULFILLED', 'FULFILLED'] } }).select('number items').lean();
  const O = new Map();
  for (const q of quotes) for (const i of q.items) { const k = String(i.productId); const o = O.get(k) || { ordered: 0, invoiced: 0, actualCost: 0 }; const f = i.unitFactor || 1; o.ordered += i.quantity * f; o.invoiced += (i.fulfilledQty || 0) * f; o.actualCost += Math.round((i.fulfilledQty || 0) * (i.costSnapshot || 0)); O.set(k, o); }
  const need = new Map();
  for (const l of doc.lines.filter((x) => x.productId)) { const k = String(l.productId); const n = need.get(k) || { productId: l.productId, description: l.description, required: 0, estCostAcc: 0 }; n.required += l.baseQuantity; n.estCostAcc += l.baseQuantity * l.estUnitCost; need.set(k, n); }
  const rows = [...need.values()].map((n) => ({ productId: n.productId, description: n.description, required: r3(n.required), estUnitCost: n.required ? Math.round(n.estCostAcc / n.required) : 0 }));
  const cmp = compareLines(rows, O);
  const offBoq = [...O.entries()].filter(([k]) => !need.has(k)).map(([k, v]) => ({ productId: k, ordered: r3(v.ordered), invoiced: r3(v.invoiced) }));
  const deliveries = await DeliveryOrder.aggregate([{ $match: { businessId: doc.businessId, projectId: doc.projectId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const est = cmp.reduce((s, r) => s + r.estCost, 0); const act = cmp.reduce((s, r) => s + r.actualCost, 0); const estInvoiced = cmp.reduce((s, r) => s + Math.round(r.invoiced * r.estUnitCost), 0);
  const freeText = doc.lines.filter((x) => !x.productId).map((x) => ({ description: x.description, quantity: x.quantity, unit: x.unitName }));
  return { projectId, lines: cmp.map((r) => ({ ...r, estUnitCost: money(r.estUnitCost), estCost: money(r.estCost), actualCost: money(r.actualCost), costVariance: money(r.costVariance) })), offBoq, freeTextLines: freeText,
    totals: { estimatedCost: money(est), estimatedCostOfInvoiced: money(estInvoiced), actualCostInvoiced: money(act), variance: money(act - estInvoiced), note: 'Variance compares actual cost of what was invoiced with the estimate for the same quantity.' }, deliveries: Object.fromEntries(deliveries.map((d) => [d._id, d.n])) };
}
module.exports = { parseCsv, compareLines, save, get, importCsv, exportCsv, status };
