/**
 * Ingredient batches and expiry: what is on the shelf, what is about to expire, writing off / returning a batch, tracing where a batch went,
 * and the hourly write-off job. Feeds the existing daily expiry alert (batch.service#expirySummary merges this in) so the owner gets ONE alert.
 */
const mongoose = require('mongoose');
const IngredientBatch = require('../../models/IngredientBatch');
const Ingredient = require('../../models/Ingredient');
const WasteRecord = require('../../models/WasteRecord');
const Supplier = require('../../models/Supplier');
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantSettings = require('../../models/RestaurantSettings');
const ApiError = require('../../utils/ApiError');
const { fromCents } = require('../../utils/money');
const { DAY, startOfToday, daysLeft } = require('../../utils/expiryDay');
const U = require('../../utils/restaurantUnits');
const C = require('./common');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const r4 = U.round4;
const MOVE = { EXPIRED: 'EXPIRED', WASTE: 'WASTE', RETURNED: 'SUPPLIER_RETURN' };
const STATUS = { EXPIRED: 'EXPIRED', WASTE: 'DISCARDED', RETURNED: 'RETURNED' };

async function windows(businessId, { criticalDays, warningDays } = {}) {
  const t = (await C.getContext(businessId)).settings.tracking || {};
  const crit = criticalDays ?? t.expiryCriticalDays ?? 3;
  return { crit, warn: Math.max(warningDays ?? t.expiryWarningDays ?? 7, crit) };
}

/** { expired, critical, warning } each { batches, units, costValue(cents) }, byBranch, top. Same shape as the product expiry summary. */
async function expirySummary(businessId, { branchId, criticalDays, warningDays, top = 5 } = {}) {
  const { crit, warn } = await windows(businessId, { criticalDays, warningDays });
  const today = startOfToday();
  const f = { businessId: oid(businessId), status: 'ACTIVE', quantity: { $gt: 0 }, expiryDate: { $ne: null, $lt: new Date(today.getTime() + (warn + 1) * DAY) } };
  if (branchId) f.branchId = oid(branchId);
  const rows = await IngredientBatch.find(f).sort({ expiryDate: 1 }).limit(3000).lean();
  const bucket = () => ({ batches: 0, units: 0, costValue: 0 });
  const out = { criticalDays: crit, warningDays: warn, expired: bucket(), critical: bucket(), warning: bucket(), byBranch: {}, top: [] };
  const soon = [];
  for (const b of rows) {
    const d = daysLeft(b.expiryDate);
    const key = d < 0 ? 'expired' : d <= crit ? 'critical' : d <= warn ? 'warning' : null;
    if (!key) continue;
    out[key].batches += 1; out[key].units = r4(out[key].units + b.quantity); out[key].costValue += Math.round(b.quantity * (b.costPerBase || 0));
    const bb = out.byBranch[b.branchId] || (out.byBranch[b.branchId] = { expired: 0, critical: 0, warning: 0 }); bb[key] += 1;
    soon.push(b);
  }
  const t = soon.slice(0, top);
  if (t.length) {
    const ings = await Ingredient.find({ _id: { $in: t.map((b) => b.ingredientId) } }).select('name baseUnit').lean();
    const nm = new Map(ings.map((i) => [String(i._id), i]));
    out.top = t.map((b) => ({ batchId: b._id, branchId: b.branchId, ingredientId: b.ingredientId, name: nm.get(String(b.ingredientId))?.name || 'Ingredient', unit: nm.get(String(b.ingredientId))?.baseUnit, batchNumber: b.batchNumber, quantity: b.quantity, expiryDate: b.expiryDate, daysLeft: daysLeft(b.expiryDate), kind: 'INGREDIENT' }));
  }
  return out;
}

const shape = (b, ing) => ({ ...b, ingredient: ing ? { _id: ing._id, name: ing.name, baseUnit: ing.baseUnit } : undefined, daysLeft: daysLeft(b.expiryDate), expired: b.expiryDate ? daysLeft(b.expiryDate) < 0 : false, value: fromCents(Math.round((b.quantity || 0) * (b.costPerBase || 0))) });

async function listBatches(businessId, user, { branchId, ingredientId, status = 'ACTIVE', location, expiringInDays, search, page = 1, limit = 50 }) {
  const f = { businessId: oid(businessId), ...C.branchFilter(C.branchScope(user, branchId)) };
  if (status) f.status = status; if (location) f.location = location;
  if (ingredientId) f.ingredientId = oid(ingredientId);
  if (status === 'ACTIVE') f.quantity = { $gt: 0 };
  if (expiringInDays !== undefined) f.expiryDate = { $ne: null, $lt: new Date(startOfToday().getTime() + (expiringInDays + 1) * DAY) };
  if (search) { const ids = await Ingredient.find({ businessId, name: new RegExp(C.escapeRegex(search), 'i') }).select('_id').limit(200); f.$or = [{ batchNumber: new RegExp(C.escapeRegex(search), 'i') }, { ingredientId: { $in: ids.map((i) => i._id) } }]; }
  const [rows, total] = await Promise.all([IngredientBatch.find(f).sort({ expiryDate: 1, receivedAt: 1 }).skip((page - 1) * limit).limit(limit).lean(), IngredientBatch.countDocuments(f)]);
  const ings = await Ingredient.find({ _id: { $in: rows.map((r) => r.ingredientId) } }).select('name baseUnit').lean();
  const nm = new Map(ings.map((i) => [String(i._id), i]));
  return C.paged(rows.map((b) => shape(b, nm.get(String(b.ingredientId)))), total, { page, limit });
}

async function listExpiring(businessId, user, { branchId, days }) {
  const { warn } = await windows(businessId);
  const r = await listBatches(businessId, user, { branchId, status: 'ACTIVE', expiringInDays: days ?? warn, limit: 200 });
  return r.items;
}

/** Closes the rest of a batch (written off, expired or sent back) INSIDE a transaction: batch -> 0, stock ledger, waste record / supplier credit. */
async function closeIn(session, batch, { type, reason, userId, ctx, creditSupplier = true }) {
  const closed = await IngredientBatch.findOneAndUpdate({ _id: batch._id, status: 'ACTIVE', quantity: { $gt: 0 } }, { $set: { quantity: 0, status: STATUS[type], closedAt: new Date(), closedBy: userId, closeReason: reason } }, { new: false, session });
  if (!closed) return null;
  const ingredients = require('./ingredient.service');
  const ing = await ingredients.getIngredient(batch.businessId, batch.ingredientId, session);
  const qty = closed.quantity; const cost = Math.round(qty * (closed.costPerBase || 0));
  await ingredients.moveStock({ businessId: batch.businessId, branchId: batch.branchId, ingredient: ing, location: batch.location, delta: -qty, type: MOVE[type], unitCost: closed.costPerBase, batchId: batch._id, referenceType: 'IngredientBatch', referenceId: batch._id, reason: reason || `Batch ${batch.batchNumber} ${type.toLowerCase()}`, userId, session, allowNegative: true });
  if (type === 'RETURNED') { if (creditSupplier && closed.supplierId && cost) await Supplier.updateOne({ _id: closed.supplierId, businessId: batch.businessId }, { $inc: { currentBalance: -cost } }, { session }); }
  else await WasteRecord.create([{ businessId: batch.businessId, branchId: batch.branchId, kind: type === 'EXPIRED' ? 'EXPIRED' : 'WASTE', ingredientId: ing._id, name: ing.name, quantity: qty, location: batch.location, cost, reason: reason || `Batch ${batch.batchNumber} ${type.toLowerCase()}`, recordedBy: userId }], { session });
  return { name: ing.name, batchNumber: batch.batchNumber, quantity: qty, cost };
}

async function disposeBatch(businessId, user, id, { type = 'WASTE', reason, creditSupplier }) {
  const batch = await IngredientBatch.findOne({ _id: id, businessId });
  if (!batch) throw ApiError.notFound('Batch not found', 'BATCH_NOT_FOUND');
  C.assertBranchAccess(user, batch.branchId);
  if (batch.status !== 'ACTIVE' || !(batch.quantity > 0)) throw ApiError.conflict('This batch has nothing left on the shelf', 'BATCH_EMPTY');
  const r = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const x = await closeIn(session, batch, { type, reason, userId: user._id, ctx, creditSupplier });
    if (!x) throw ApiError.conflict('This batch was just used up or closed', 'BATCH_CHANGED');
    await C.audit({ businessId, branchId: batch.branchId, userId: user._id, action: `ingredient.batch.${type.toLowerCase()}`, entityType: 'IngredientBatch', entityId: batch._id, newValue: { quantity: x.quantity, reason } }, session);
    return x;
  });
  return { batchId: batch._id, status: STATUS[type], ...r, cost: fromCents(r.cost) };
}

/** Where did this batch go? Every order item that drew from it. */
async function trace(businessId, user, id) {
  const batch = await IngredientBatch.findOne({ _id: id, businessId }).lean();
  if (!batch) throw ApiError.notFound('Batch not found', 'BATCH_NOT_FOUND');
  C.assertBranchAccess(user, batch.branchId);
  const rows = await RestaurantOrder.aggregate([{ $match: { businessId: oid(businessId), 'items.stockLines.batches.batchId': batch._id } }, { $unwind: '$items' }, { $match: { 'items.stockLines.batches.batchId': batch._id } }, { $project: { orderNumber: 1, createdAt: 1, name: '$items.name', quantity: '$items.quantity', lines: '$items.stockLines' } }, { $sort: { createdAt: -1 } }, { $limit: 300 }]);
  const orders = rows.map((r) => ({ orderId: r._id, orderNumber: r.orderNumber, at: r.createdAt, dish: r.name, portions: r.quantity, used: r4(r.lines.flatMap((l) => l.batches || []).filter((b) => String(b.batchId) === String(batch._id)).reduce((t, b) => t + b.quantity, 0)) }));
  const ing = await Ingredient.findById(batch.ingredientId).select('name baseUnit').lean();
  return { batch: shape(batch, ing), usedInOrders: orders, totalUsed: r4(orders.reduce((t, o) => t + o.used, 0)) };
}

/** Hourly: write expired batches off (waste cost), for restaurants that left "auto write-off" on. The others keep them listed for a manager. */
async function expirySweep(businessId) {
  const today = startOfToday();
  const filter = { ...(businessId ? { businessId } : {}), status: 'ACTIVE', quantity: { $gt: 0 }, expiryDate: { $lt: today } };
  const expired = await IngredientBatch.find(filter).limit(500);
  if (!expired.length) return { writtenOff: 0, skipped: 0 };
  const ids = [...new Set(expired.map((b) => String(b.businessId)))];
  const cfg = await RestaurantSettings.find({ businessId: { $in: ids } }).select('businessId tracking').lean();
  const off = new Set(cfg.filter((c) => c.tracking && c.tracking.autoWriteOffExpired === false).map((c) => String(c.businessId)));
  const done = new Map(); let skipped = 0;
  for (const b of expired) {
    if (off.has(String(b.businessId))) { skipped += 1; continue; }
    try {
      const r = await C.inTx(async (session) => { const ctx = await C.getContext(b.businessId, session); return closeIn(session, b, { type: 'EXPIRED', reason: `Batch ${b.batchNumber} expired`, ctx }); });
      if (!r) continue;
      const k = `${b.businessId}:${b.branchId}`; if (!done.has(k)) done.set(k, { businessId: b.businessId, branchId: b.branchId, list: [], cost: 0 });
      const g = done.get(k); g.list.push(`${r.name} (${r.batchNumber})`); g.cost += r.cost;
    } catch (e) { console.error('[restaurant] expiry write-off failed', e.message); }
  }
  for (const g of done.values()) {
    let money = (g.cost / 100).toFixed(2);
    try { money = (await require('../../utils/businessContext').getBusinessContext(g.businessId)).fmt(g.cost); } catch (e) { /* plain number is fine */ }
    await C.notifyManagement(g.businessId, { type: 'INGREDIENT_EXPIRY', title: 'Expired ingredients were written off', message: `${g.list.slice(0, 6).join(', ')}${g.list.length > 6 ? ` and ${g.list.length - 6} more` : ''}. Lost value: ${money}.`, branchId: g.branchId, entityType: 'IngredientBatch' });
  }
  return { writtenOff: [...done.values()].reduce((s, g) => s + g.list.length, 0), skipped };
}

module.exports = { expirySummary, listBatches, listExpiring, disposeBatch, trace, expirySweep };
