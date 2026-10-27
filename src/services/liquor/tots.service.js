/**
 * Tot (shot) sales from open bottles.
 * A tot product has no stock of its own. Selling it pours millilitres out of the branch's "open bottle pool"; when the pool is short,
 * whole bottles are opened (taken from the bottle product's normal stock) in the same transaction as the sale.
 * Cancels and refunds put the millilitres back (and un-open a bottle when a whole one is back). Dip counts record what is really left.
 */
const OpenBottle = require('../../models/OpenBottle');
const TotDraw = require('../../models/TotDraw');
const TotCount = require('../../models/TotCount');
const LiquorDetails = require('../../models/LiquorDetails');
const Product = require('../../models/Product');
const AuditLog = require('../../models/AuditLog');
const { applyStockChange } = require('../inventory.service');
const withTx = require('../../utils/withTx');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');

async function getPool(businessId, branchId, bottleProductId, volumeMl, session) {
  const q = OpenBottle.findOne({ businessId, branchId, bottleProductId }); if (session) q.session(session);
  let pool = await q;
  if (!pool) { const [c] = await OpenBottle.create([{ businessId, branchId, bottleProductId, volumeMl, openMl: 0 }], { session }); pool = c; }
  if (volumeMl && pool.volumeMl !== volumeMl) pool.volumeMl = volumeMl;
  return pool;
}

/** pour `ml` out of the pool, opening bottles as needed. Returns how many bottles were opened. */
async function pour({ businessId, branchId, pool, ml, userId, stockType, referenceType, referenceId, reason, session }) {
  let opened = 0;
  if (pool.openMl < ml) {
    opened = Math.ceil((ml - pool.openMl) / pool.volumeMl);
    await applyStockChange({ businessId, branchId, productId: pool.bottleProductId, variantId: null, quantityDelta: -opened, type: stockType, referenceType, referenceId, reason, performedBy: userId, session });
  }
  pool.openMl = pool.openMl + opened * pool.volumeMl - ml; pool.bottlesOpened += opened;
  await pool.save({ session });
  return opened;
}

async function draw({ businessId, branchId, saleId, totProductId, bottleProductId, volumeMl, mlPerTot, tots, userId, receiptNumber, session }) {
  const pool = await getPool(businessId, branchId, bottleProductId, volumeMl, session);
  const opened = await pour({ businessId, branchId, pool, ml: tots * mlPerTot, userId, stockType: 'SALE', referenceType: 'Sale', referenceId: saleId, reason: `Tots sold${receiptNumber ? ` (${receiptNumber})` : ''}`, session });
  await TotDraw.create([{ businessId, branchId, saleId, totProductId, bottleProductId, tots, mlPerTot, bottlesOpened: opened }], { session });
  return { opened, openMl: pool.openMl };
}

/** put tots back after a cancel (tots omitted = everything left) or a refund of `tots` */
async function reverse({ businessId, saleId, totProductId, tots, userId, session }) {
  const q = TotDraw.find({ businessId, saleId, ...(totProductId ? { totProductId } : {}) }).session(session);
  const draws = await q; let left = tots;
  for (const d of draws) {
    const remaining = d.tots - d.restoredTots; if (remaining <= 0) continue;
    const back = left == null ? remaining : Math.min(remaining, left); if (back <= 0) continue;
    const pool = await OpenBottle.findOne({ businessId, branchId: d.branchId, bottleProductId: d.bottleProductId }).session(session);
    if (pool) {
      pool.openMl += back * d.mlPerTot;
      while (pool.bottlesOpened > 0 && pool.openMl >= pool.volumeMl) { // a whole bottle is back: it was never needed
        pool.openMl -= pool.volumeMl; pool.bottlesOpened -= 1;
        await applyStockChange({ businessId, branchId: d.branchId, productId: d.bottleProductId, variantId: null, quantityDelta: 1, type: 'RETURN', referenceType: 'Sale', referenceId: saleId, reason: 'Tots returned: bottle not needed', performedBy: userId, session, allowNegative: true });
      }
      await pool.save({ session });
    }
    d.restoredTots += back; await d.save({ session });
    if (left != null) left -= back;
  }
}

async function bottleInfo(businessId, bottleProductId) {
  const [p, d] = await Promise.all([Product.findOne({ _id: bottleProductId, businessId }).select('name costPrice'), LiquorDetails.findOne({ businessId, productId: bottleProductId })]);
  if (!p || !d || !d.volumeMl) throw ApiError.badRequest('Bottle product or its volume is missing', 'BOTTLE_VOLUME_MISSING');
  return { p, volumeMl: d.volumeMl };
}

/** Dip count: the measured millilitres left in open bottles replace the expected figure; the difference is logged. */
async function count(businessId, user, { branchId, bottleProductId, measuredMl, reason }) {
  assertBranchAccess(user, branchId);
  const { p, volumeMl } = await bottleInfo(businessId, bottleProductId);
  if (measuredMl > volumeMl * 20) throw ApiError.badRequest('That is more liquid than 20 bottles. Check the number.', 'INVALID_MEASURE');
  return withTx(async (session) => {
    const pool = await getPool(businessId, branchId, bottleProductId, volumeMl, session);
    const expected = pool.openMl; const variance = measuredMl - expected;
    pool.openMl = measuredMl; await pool.save({ session });
    const [row] = await TotCount.create([{ businessId, branchId, bottleProductId, type: 'COUNT', expectedMl: expected, measuredMl, varianceMl: variance, costValue: Math.round((variance / volumeMl) * p.costPrice), reason, createdBy: user._id }], { session });
    await AuditLog.create([{ businessId, branchId, userId: user._id, action: 'liquor.tots.count', entityType: 'TotCount', entityId: row._id, newValue: { expected, measuredMl, variance } }], { session });
    return { expectedMl: expected, measuredMl, varianceMl: variance, costValue: fromCents(row.costValue), id: row._id };
  });
}

/** Waste (spilt, tasting) or comp (given free) pour: leaves the pool like a sale, but earns nothing. */
async function wasteOrComp(businessId, user, { branchId, bottleProductId, ml, type, reason }) {
  assertBranchAccess(user, branchId);
  const { p, volumeMl } = await bottleInfo(businessId, bottleProductId);
  return withTx(async (session) => {
    const pool = await getPool(businessId, branchId, bottleProductId, volumeMl, session);
    const row = new TotCount({ businessId, branchId, bottleProductId, type, expectedMl: pool.openMl, varianceMl: -ml, costValue: -Math.round((ml / volumeMl) * p.costPrice), reason, createdBy: user._id });
    const opened = await pour({ businessId, branchId, pool, ml, userId: user._id, stockType: 'DAMAGE', referenceType: 'TotCount', referenceId: row._id, reason: `${type === 'COMP' ? 'Complimentary' : 'Wasted'} pour: ${reason}`, session });
    row.measuredMl = pool.openMl; await row.save({ session });
    return { id: row._id, openedBottles: opened, openMl: pool.openMl, costValue: fromCents(row.costValue) };
  });
}

async function pools(businessId, user, { branchId } = {}) {
  if (branchId) assertBranchAccess(user, branchId);
  const rows = await OpenBottle.find({ businessId, ...(branchId ? { branchId } : {}) }).populate('bottleProductId', 'name sku costPrice').lean();
  const tots = await LiquorDetails.find({ businessId, 'tot.bottleProductId': { $in: rows.map((r) => r.bottleProductId._id) } }).select('tot').lean();
  return rows.map((r) => { const t = tots.filter((x) => String(x.tot.bottleProductId) === String(r.bottleProductId._id)); const smallest = t.length ? Math.min(...t.map((x) => x.tot.ml)) : null;
    return { branchId: r.branchId, bottleProductId: r.bottleProductId._id, name: r.bottleProductId.name, volumeMl: r.volumeMl, openMl: r.openMl, bottlesOpened: r.bottlesOpened, totsLeft: smallest ? Math.floor(r.openMl / smallest) : null, valueLeft: fromCents(Math.round((r.openMl / r.volumeMl) * r.bottleProductId.costPrice)) }; });
}

async function variance(businessId, user, { from, to, branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const mongoose = require('mongoose'); const oid = (x) => new mongoose.Types.ObjectId(String(x));
  const m = { businessId: oid(businessId), createdAt: { $gte: from, $lte: to } }; if (branchId) m.branchId = oid(branchId);
  const rows = await TotCount.aggregate([{ $match: m }, { $group: { _id: { p: '$bottleProductId', t: '$type' }, ml: { $sum: '$varianceMl' }, value: { $sum: '$costValue' }, n: { $sum: 1 } } }]);
  const names = new Map((await Product.find({ _id: { $in: rows.map((r) => r._id.p) } }).select('name').lean()).map((p) => [String(p._id), p.name]));
  const by = new Map();
  for (const r of rows) { const k = String(r._id.p); const x = by.get(k) || { bottleProductId: r._id.p, name: names.get(k) || 'Unknown', countVarianceMl: 0, wasteMl: 0, compMl: 0, countValue: 0, wasteValue: 0, compValue: 0 };
    if (r._id.t === 'COUNT') { x.countVarianceMl += r.ml; x.countValue += r.value; } else if (r._id.t === 'WASTE') { x.wasteMl += r.ml; x.wasteValue += r.value; } else { x.compMl += r.ml; x.compValue += r.value; } by.set(k, x); }
  const items = [...by.values()].map((x) => ({ ...x, countValue: fromCents(x.countValue), wasteValue: fromCents(x.wasteValue), compValue: fromCents(x.compValue) }));
  const missing = items.reduce((s, x) => s + Math.min(0, x.countVarianceMl), 0);
  return { from, to, items, totalMissingMl: missing, note: 'Negative = liquid that is missing / poured out. Count variance is the gap between what the sales say is left and what was measured.' };
}

module.exports = { draw, reverse, count, wasteOrComp, pools, variance };
