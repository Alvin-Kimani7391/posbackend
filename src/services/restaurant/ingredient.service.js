/**
 * Ingredient catalogue and stock. Every quantity is stored in the ingredient's BASE unit (g / ml / piece).
 * moveStock is the ONLY function that changes IngredientStock, so there is one place to get concurrency and the ledger right.
 */
const Ingredient = require('../../models/Ingredient');
const IngredientStock = require('../../models/IngredientStock');
const IngredientBatch = require('../../models/IngredientBatch');
const IngredientMovement = require('../../models/IngredientMovement');
const IngredientPurchase = require('../../models/IngredientPurchase');
const IngredientCount = require('../../models/IngredientCount');
const WasteRecord = require('../../models/WasteRecord');
const Supplier = require('../../models/Supplier');
const Recipe = require('../../models/Recipe');
const MenuItem = require('../../models/MenuItem');
const ApiError = require('../../utils/ApiError');
const { nextSequence, pad } = require('../../models/Counter');
const U = require('../../utils/restaurantUnits');
const { consumption, costOf } = require('../../utils/restaurantRecipe');
const { fromCents } = require('../../utils/money');
const { startOfToday, isExpired, sameDay } = require('../../utils/expiryDay');
const C = require('./common');

const effLocation = (settings, location) => (settings.stockLocations === 'SINGLE' ? 'STORE' : location || 'STORE');
const round4 = U.round4;

async function getIngredient(businessId, id, session) {
  const ing = await C.withSession(Ingredient.findOne({ _id: id, businessId }), session);
  if (!ing) throw ApiError.notFound('Ingredient not found', 'INGREDIENT_NOT_FOUND');
  return ing;
}

/** Quantity typed in any compatible unit -> base units. */
function toBaseFor(ingredient, quantity, unit) {
  const u = unit || ingredient.baseUnit;
  if (!U.isUnit(u) || U.baseUnitFor(u) !== ingredient.baseUnit) throw ApiError.badRequest(`${ingredient.name} is measured in ${ingredient.baseUnit}; "${u}" is not compatible`, 'UNIT_INCOMPATIBLE');
  return U.toBase(quantity, u);
}

// ------------------------------------------------------------------ catalogue
function costToBase(cost, baseUnit) {
  // cost = { amountCents, per } : "KES 120 per kg" -> cents per base unit
  if (!cost) return undefined;
  const per = cost.per || baseUnit;
  if (!U.isUnit(per) || U.baseUnitFor(per) !== baseUnit) throw ApiError.badRequest('Cost unit does not match the ingredient unit', 'UNIT_INCOMPATIBLE');
  return cost.amountCents / U.toBase(1, per);
}

async function createIngredient(businessId, userId, input) {
  const { cost, ...rest } = input;
  if (rest.purchaseUnit && U.baseUnitFor(rest.purchaseUnit) !== rest.baseUnit) throw ApiError.badRequest('Purchase unit does not match the base unit', 'UNIT_INCOMPATIBLE');
  const ing = await Ingredient.create({ ...rest, businessId, costPerBase: costToBase(cost, rest.baseUnit) ?? 0 });
  await C.audit({ businessId, userId, action: 'ingredient.create', entityType: 'Ingredient', entityId: ing._id, newValue: { name: ing.name } });
  return ing;
}

async function updateIngredient(businessId, userId, id, input) {
  const ing = await getIngredient(businessId, id);
  const { cost, baseUnit, ...rest } = input;
  if (baseUnit && baseUnit !== ing.baseUnit) {
    const used = await IngredientStock.exists({ businessId, ingredientId: ing._id, quantity: { $ne: 0 } });
    if (used) throw ApiError.conflict('The unit cannot change while the ingredient has stock or history', 'UNIT_LOCKED');
    ing.baseUnit = baseUnit;
  }
  const oldCost = ing.costPerBase;
  Object.assign(ing, rest);
  if (cost) ing.costPerBase = costToBase(cost, ing.baseUnit);
  await ing.save();
  if (ing.costPerBase !== oldCost) await require('./recipe.service').refreshCosts(businessId, [ing._id]);
  await C.audit({ businessId, userId, action: 'ingredient.update', entityType: 'Ingredient', entityId: ing._id, oldValue: { costPerBase: oldCost }, newValue: { costPerBase: ing.costPerBase } });
  return ing;
}

async function listIngredients(businessId, { search, status = 'active', page = 1, limit = 50 }) {
  const f = { businessId, status };
  if (search) f.name = new RegExp(C.escapeRegex(search), 'i');
  const [items, total] = await Promise.all([Ingredient.find(f).sort({ name: 1 }).skip((page - 1) * limit).limit(limit), Ingredient.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}

// ------------------------------------------------------------------ the one stock mutator
async function moveStock({ businessId, branchId, ingredient, location, delta, type, unitCost, batchId, referenceType, referenceId, reason, userId, session, allowNegative = false }) {
  if (!session) throw new Error('moveStock requires a session');
  if (!delta) return null;
  const filter = { businessId, branchId, ingredientId: ingredient._id, location };
  let row;
  if (delta > 0 || allowNegative) {
    row = await IngredientStock.findOneAndUpdate(filter, { $inc: { quantity: delta } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
  } else {
    row = await IngredientStock.findOneAndUpdate({ ...filter, quantity: { $gte: -delta } }, { $inc: { quantity: delta } }, { new: true, session });
    if (!row) {
      const cur = await IngredientStock.findOne(filter).session(session);
      throw ApiError.badRequest(`Not enough ${ingredient.name} in ${location.toLowerCase()} (have ${round4(cur?.quantity || 0)} ${ingredient.baseUnit}, need ${round4(-delta)})`, 'INSUFFICIENT_INGREDIENT');
    }
  }
  const prev = round4(row.quantity - delta);
  const uc = unitCost ?? ingredient.costPerBase ?? 0;
  await IngredientMovement.create([{
    businessId, branchId, ingredientId: ingredient._id, location, type, quantity: delta, previousQty: prev, newQty: round4(row.quantity),
    unitCost: uc, value: Math.round(Math.abs(delta) * uc), batchId, referenceType, referenceId, reason, performedBy: userId,
  }], { session });
  if (delta < 0 && ingredient.lowStockLevel > 0 && prev > ingredient.lowStockLevel && row.quantity <= ingredient.lowStockLevel) {
    C.notifyRoles(businessId, branchId, [...C.FLOOR_LEAD_ROLES, 'STOREKEEPER', 'CHEF'], {
      type: 'INGREDIENT_LOW_STOCK', title: `Low stock: ${ingredient.name}`, message: `${ingredient.name} is down to ${round4(row.quantity)} ${ingredient.baseUnit} in the ${location.toLowerCase()}.`, entityType: 'Ingredient', entityId: ingredient._id,
    });
  }
  return { previousQty: prev, newQty: row.quantity };
}

/** Takes up to `qty` from the batches (first-expiring first), skipping expired. Returns [{batchId, quantity}] and how much was NOT covered by a batch. */
async function drawBatches({ businessId, branchId, ingredientId, location, qty, session }) {
  const now = new Date();
  const batches = await IngredientBatch.find({ businessId, branchId, ingredientId, location, status: 'ACTIVE', quantity: { $gt: 0 }, $or: [{ expiryDate: null }, { expiryDate: { $gte: startOfToday(now) } }] })
    .sort({ expiryDate: 1, receivedAt: 1 }).session(session);
  batches.sort((a, b) => (a.expiryDate ? a.expiryDate.getTime() : Infinity) - (b.expiryDate ? b.expiryDate.getTime() : Infinity) || a.receivedAt - b.receivedAt);
  const taken = []; let left = qty;
  for (const b of batches) {
    if (left <= 1e-9) break;
    const take = Math.min(b.quantity, left);
    const upd = await IngredientBatch.findOneAndUpdate({ _id: b._id, quantity: { $gte: take } }, { $inc: { quantity: -take } }, { new: true, session });
    if (!upd) continue;
    if (upd.quantity <= 1e-9) { upd.status = 'EXHAUSTED'; await upd.save({ session }); }
    taken.push({ batchId: b._id, quantity: round4(take) }); left = round4(left - take);
  }
  return { taken, uncovered: Math.max(0, round4(left)) };
}

/**
 * Consumes ingredient lines ([{ingredientId, quantity(base)}]). Returns stockLines that let the exact same consumption be reversed.
 * Missing stock never blocks service when settings.allowNegativeIngredients is on (the default): it goes negative and shows up in variance.
 */
async function consume({ businessId, branchId, lines, location, type = 'CONSUMPTION', referenceType, referenceId, reason, userId, session, ctx }) {
  const out = [];
  const loc = effLocation(ctx.settings, location);
  for (const l of lines) {
    const ing = await getIngredient(businessId, l.ingredientId, session);
    let batches = [];
    if (ing.trackBatch) batches = (await drawBatches({ businessId, branchId, ingredientId: ing._id, location: loc, qty: l.quantity, session })).taken;
    await moveStock({ businessId, branchId, ingredient: ing, location: loc, delta: -l.quantity, type, referenceType, referenceId, reason, userId, session, allowNegative: ctx.settings.allowNegativeIngredients !== false });
    out.push({ ingredientId: ing._id, location: loc, quantity: l.quantity, unitCost: ing.costPerBase || 0, batches });
  }
  return out;
}

/** Puts a previous consumption back (void before preparation). Batches go back where they came from. */
async function reverse({ businessId, branchId, stockLines, referenceType, referenceId, reason, userId, session }) {
  for (const l of stockLines) {
    const ing = await getIngredient(businessId, l.ingredientId, session);
    for (const b of l.batches || []) {
      const bt = await IngredientBatch.findOneAndUpdate({ _id: b.batchId }, { $inc: { quantity: b.quantity } }, { new: true, session });
      if (bt && bt.status === 'EXHAUSTED') { bt.status = 'ACTIVE'; await bt.save({ session }); }
    }
    await moveStock({ businessId, branchId, ingredient: ing, location: l.location, delta: l.quantity, type: 'CONSUMPTION_REVERSAL', unitCost: l.unitCost, referenceType, referenceId, reason, userId, session });
  }
}

// ------------------------------------------------------------------ receiving / purchasing
async function receivePurchase(businessId, branchId, user, { supplierId, invoiceNumber, lines, amountPaid = 0, notes }) {
  await C.assertBranch(businessId, branchId);
  C.assertBranchAccess(user, branchId);
  const out = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    if (supplierId) { const s = await Supplier.findOne({ _id: supplierId, businessId }).session(session); if (!s) throw ApiError.badRequest('Supplier not found', 'SUPPLIER_NOT_FOUND'); }
    const seq = await nextSequence(businessId, 'ingpurchase', session);
    const purchaseId = new (require('mongoose').Types.ObjectId)();
    const now = new Date(); const pLines = []; const touched = []; let total = 0;
    for (const l of lines) {
      const ing = await getIngredient(businessId, l.ingredientId, session);
      const unit = l.unit || ing.purchaseUnit || ing.baseUnit;
      const baseQty = toBaseFor(ing, l.quantity, unit);
      if (!(baseQty > 0)) throw ApiError.badRequest('Quantity must be more than zero', 'INVALID_QUANTITY');
      const costPerBase = l.unitCostCents / U.toBase(1, unit);
      const lineTotal = Math.round(l.quantity * l.unitCostCents);
      const loc = effLocation(ctx.settings, l.location);
      let expiry = l.expiryDate;
      if (ing.trackBatch) {
        if (!l.batchNumber) { const n = await nextSequence(businessId, 'ingbatch', session); const d = now.toISOString().slice(0, 10).replace(/-/g, ''); l.batchNumber = `${(ing.sku || ing.name.replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'ING').toUpperCase()}-${d}-${pad(n, 3)}`; }   // no supplier batch number: we make one
        if (!expiry && ing.shelfLifeDays) expiry = new Date(now.getTime() + ing.shelfLifeDays * 86400000);
        if (expiry && isExpired(expiry, now)) throw ApiError.badRequest(`${ing.name}: this batch is already expired`, 'BATCH_EXPIRED');
        const existing = await IngredientBatch.findOne({ businessId, branchId, ingredientId: ing._id, location: loc, batchNumber: l.batchNumber }).session(session);
        if (existing && expiry && existing.expiryDate && !sameDay(existing.expiryDate, expiry)) throw ApiError.badRequest(`${ing.name}: batch ${l.batchNumber} is already on the shelf with a different expiry date. Use a different batch number.`, 'BATCH_EXPIRY_MISMATCH');
        await IngredientBatch.findOneAndUpdate(
          { businessId, branchId, ingredientId: ing._id, location: loc, batchNumber: l.batchNumber },
          { $inc: { quantity: baseQty, initialQuantity: baseQty }, $set: { status: 'ACTIVE', costPerBase, supplierId, purchaseId }, $setOnInsert: { expiryDate: expiry, receivedAt: now } },
          { upsert: true, new: true, session, setDefaultsOnInsert: true }
        );
      }
      // moving weighted-average cost across every location of the business
      const agg = await IngredientStock.aggregate([{ $match: { businessId: ing.businessId, ingredientId: ing._id, quantity: { $gt: 0 } } }, { $group: { _id: null, q: { $sum: '$quantity' } } }]).session(session);
      const oldQty = agg[0]?.q || 0;
      const newAvg = oldQty > 0 ? ((oldQty * (ing.costPerBase || 0)) + (baseQty * costPerBase)) / (oldQty + baseQty) : costPerBase;
      await moveStock({ businessId, branchId, ingredient: ing, location: loc, delta: baseQty, type: 'RECEIPT', unitCost: costPerBase, referenceType: 'IngredientPurchase', referenceId: purchaseId, reason: `Purchase ${invoiceNumber || ''}`.trim(), userId: user._id, session });
      ing.costPerBase = newAvg; await ing.save({ session }); touched.push(ing._id);
      total += lineTotal;
      pLines.push({ ingredientId: ing._id, name: ing.name, location: loc, purchaseQuantity: l.quantity, purchaseUnit: unit, baseQuantity: baseQty, costPerBase, lineTotal, batchNumber: l.batchNumber, expiryDate: expiry });
    }
    const [purchase] = await IngredientPurchase.create([{ _id: purchaseId, businessId, branchId, purchaseNumber: `IP-${pad(seq)}`, supplierId, invoiceNumber, lines: pLines, total, amountPaid, notes, receivedBy: user._id, receivedAt: now }], { session });
    if (supplierId && total - amountPaid !== 0) await Supplier.updateOne({ _id: supplierId, businessId }, { $inc: { currentBalance: total - amountPaid } }, { session });
    await C.audit({ businessId, branchId, userId: user._id, action: 'ingredient.receive', entityType: 'IngredientPurchase', entityId: purchase._id, newValue: { total, lines: pLines.length } }, session);
    return { purchase, touched };
  });
  await require('./recipe.service').refreshCosts(businessId, out.touched); // costs follow purchase prices
  return out.purchase;
}

async function listPurchases(businessId, { branchId, supplierId, from, to, page = 1, limit = 20 }, user) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (supplierId) f.supplierId = supplierId;
  if (from || to) { f.receivedAt = {}; if (from) f.receivedAt.$gte = new Date(from); if (to) f.receivedAt.$lte = new Date(to); }
  const [items, total] = await Promise.all([IngredientPurchase.find(f).sort({ receivedAt: -1 }).skip((page - 1) * limit).limit(limit), IngredientPurchase.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}

// ------------------------------------------------------------------ transfers, waste, adjustments
async function transfer(businessId, branchId, user, { ingredientId, quantity, unit, from, to, reason }) {
  C.assertBranchAccess(user, branchId);
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    if (ctx.settings.stockLocations === 'SINGLE') throw ApiError.badRequest('This restaurant uses a single stock location. Switch to store/kitchen/bar locations in settings first.', 'SINGLE_LOCATION');
    if (from === to) throw ApiError.badRequest('Choose two different locations', 'SAME_LOCATION');
    const ing = await getIngredient(businessId, ingredientId, session);
    const base = toBaseFor(ing, quantity, unit);
    const ref = new (require('mongoose').Types.ObjectId)();
    let drawn = [];
    if (ing.trackBatch) {
      const r = await drawBatches({ businessId, branchId, ingredientId: ing._id, location: from, qty: base, session });
      drawn = r.taken;
      for (const d of drawn) {
        const src = await IngredientBatch.findById(d.batchId).session(session);
        await IngredientBatch.findOneAndUpdate(
          { businessId, branchId, ingredientId: ing._id, location: to, batchNumber: src.batchNumber },
          { $inc: { quantity: d.quantity, initialQuantity: d.quantity }, $set: { status: 'ACTIVE', costPerBase: src.costPerBase }, $setOnInsert: { expiryDate: src.expiryDate, receivedAt: src.receivedAt } },
          { upsert: true, session, setDefaultsOnInsert: true }
        );
      }
    }
    await moveStock({ businessId, branchId, ingredient: ing, location: from, delta: -base, type: 'TRANSFER_OUT', referenceType: 'IngredientTransfer', referenceId: ref, reason, userId: user._id, session, allowNegative: false });
    await moveStock({ businessId, branchId, ingredient: ing, location: to, delta: base, type: 'TRANSFER_IN', referenceType: 'IngredientTransfer', referenceId: ref, reason, userId: user._id, session });
    await C.audit({ businessId, branchId, userId: user._id, action: 'ingredient.transfer', entityType: 'Ingredient', entityId: ing._id, newValue: { from, to, quantity: base } }, session);
    return { ingredientId: ing._id, from, to, quantity: base, unit: ing.baseUnit };
  });
}

const WASTE_MOVEMENT = { WASTE: 'WASTE', SPOILAGE: 'SPOILAGE', EXPIRED: 'EXPIRED', STAFF_MEAL: 'STAFF_MEAL', COMPLIMENTARY: 'COMPLIMENTARY', REMAKE: 'WASTE' };

async function recordWaste(businessId, branchId, user, { ingredientId, quantity, unit, kind, reason, location }) {
  C.assertBranchAccess(user, branchId);
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const ing = await getIngredient(businessId, ingredientId, session);
    const base = toBaseFor(ing, quantity, unit);
    const lines = await consume({ businessId, branchId, lines: [{ ingredientId: ing._id, quantity: base }], location, type: WASTE_MOVEMENT[kind], referenceType: 'WasteRecord', reason: reason || kind, userId: user._id, session, ctx });
    const [rec] = await WasteRecord.create([{ businessId, branchId, kind, ingredientId: ing._id, name: ing.name, quantity: base, location: lines[0].location, cost: Math.round(base * (ing.costPerBase || 0)), reason, recordedBy: user._id }], { session });
    await C.audit({ businessId, branchId, userId: user._id, action: 'ingredient.waste', entityType: 'WasteRecord', entityId: rec._id, newValue: { kind, quantity: base, ingredient: ing.name } }, session);
    return rec;
  });
}

async function adjustStock(businessId, branchId, user, { ingredientId, quantity, unit, direction, reason, location }) {
  C.assertBranchAccess(user, branchId);
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const ing = await getIngredient(businessId, ingredientId, session);
    const base = toBaseFor(ing, quantity, unit);
    const loc = effLocation(ctx.settings, location);
    const r = await moveStock({ businessId, branchId, ingredient: ing, location: loc, delta: direction === 'IN' ? base : -base, type: 'ADJUSTMENT', referenceType: 'ManualAdjustment', reason, userId: user._id, session, allowNegative: ctx.settings.allowNegativeIngredients !== false });
    await C.audit({ businessId, branchId, userId: user._id, action: 'ingredient.adjust', entityType: 'Ingredient', entityId: ing._id, newValue: { direction, base, reason } }, session);
    return r;
  });
}

// ------------------------------------------------------------------ stock counts
async function startCount(businessId, branchId, user, { location }) {
  C.assertBranchAccess(user, branchId);
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const loc = effLocation(ctx.settings, location);
    if (await IngredientCount.exists({ businessId, branchId, location: loc, status: { $in: ['OPEN', 'SUBMITTED'] } })) throw ApiError.conflict('A count is already in progress for this location', 'COUNT_IN_PROGRESS');
    const [ings, stocks] = await Promise.all([Ingredient.find({ businessId, status: 'active' }).sort({ name: 1 }).session(session), IngredientStock.find({ businessId, branchId, location: loc }).session(session)]);
    const qty = new Map(stocks.map((s) => [String(s.ingredientId), s.quantity]));
    const seq = await nextSequence(businessId, 'ingcount', session);
    const [c] = await IngredientCount.create([{ businessId, branchId, location: loc, countNumber: `SC-${pad(seq)}`, startedBy: user._id, lines: ings.map((i) => ({ ingredientId: i._id, name: i.name, baseUnit: i.baseUnit, systemQty: round4(qty.get(String(i._id)) || 0) })) }], { session });
    return c;
  });
}

async function submitCount(businessId, user, id, { lines, notes }) {
  const c = await IngredientCount.findOne({ _id: id, businessId });
  if (!c) throw ApiError.notFound('Count not found');
  C.assertBranchAccess(user, c.branchId);
  if (c.status !== 'OPEN') throw ApiError.conflict(`Count is ${c.status}`, 'INVALID_COUNT_STATE');
  const byId = new Map(c.lines.map((l) => [String(l.ingredientId), l]));
  for (const l of lines) {
    const row = byId.get(String(l.ingredientId));
    if (!row) throw ApiError.badRequest('Ingredient is not part of this count', 'INGREDIENT_NOT_IN_COUNT');
    const ing = await getIngredient(businessId, l.ingredientId);
    row.countedQty = toBaseFor(ing, l.countedQuantity, l.unit); row.variance = round4(row.countedQty - row.systemQty); row.reason = l.reason;
  }
  c.status = 'SUBMITTED'; c.submittedBy = user._id; c.submittedAt = new Date(); c.notes = notes;
  await c.save();
  return c;
}

/** Approving writes the variances as COUNT_ADJUSTMENT movements (variance = counted - system at the START of the count, so sales made during the count are preserved). */
async function approveCount(businessId, user, id) {
  return C.inTx(async (session) => {
    const c = await IngredientCount.findOne({ _id: id, businessId }).session(session);
    if (!c) throw ApiError.notFound('Count not found');
    C.assertBranchAccess(user, c.branchId);
    if (c.status !== 'SUBMITTED') throw ApiError.conflict(`Count is ${c.status}`, 'INVALID_COUNT_STATE');
    if (String(c.submittedBy) === String(user._id) && user.role !== 'OWNER' && user.role !== 'ADMIN') throw ApiError.forbidden('Someone other than the person who counted must approve', 'SELF_APPROVAL');
    for (const l of c.lines) {
      if (l.countedQty === undefined || l.countedQty === null || !l.variance) continue;
      const ing = await getIngredient(businessId, l.ingredientId, session);
      await moveStock({ businessId, branchId: c.branchId, ingredient: ing, location: c.location, delta: l.variance, type: 'COUNT_ADJUSTMENT', referenceType: 'IngredientCount', referenceId: c._id, reason: l.reason || 'Stock count variance', userId: user._id, session, allowNegative: true });
    }
    c.status = 'APPROVED'; c.approvedBy = user._id; c.approvedAt = new Date();
    await c.save({ session });
    await C.audit({ businessId, branchId: c.branchId, userId: user._id, action: 'ingredient.count.approve', entityType: 'IngredientCount', entityId: c._id, newValue: { variances: c.lines.filter((l) => l.variance).length } }, session);
    return c;
  });
}

async function cancelCount(businessId, user, id) {
  const c = await IngredientCount.findOne({ _id: id, businessId });
  if (!c) throw ApiError.notFound('Count not found');
  if (!['OPEN', 'SUBMITTED'].includes(c.status)) throw ApiError.conflict(`Count is ${c.status}`, 'INVALID_COUNT_STATE');
  c.status = 'CANCELLED'; await c.save(); return c;
}
const getCount = async (businessId, id) => { const c = await IngredientCount.findOne({ _id: id, businessId }); if (!c) throw ApiError.notFound('Count not found'); return c; };
async function listCounts(businessId, { branchId, status, page = 1, limit = 20 }, user) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) }; if (status) f.status = status;
  const [items, total] = await Promise.all([IngredientCount.find(f).select('-lines').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), IngredientCount.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}

// ------------------------------------------------------------------ views
async function listStock(businessId, user, { branchId, location, lowOnly, search, page = 1, limit = 100 }) {
  const scope = C.branchScope(user, branchId);
  const ingFilter = { businessId, status: 'active' }; if (search) ingFilter.name = new RegExp(C.escapeRegex(search), 'i');
  const ings = await Ingredient.find(ingFilter).sort({ name: 1 });
  const sf = { businessId, ...C.branchFilter(scope), ingredientId: { $in: ings.map((i) => i._id) } }; if (location) sf.location = location;
  const stocks = await IngredientStock.find(sf);
  const by = new Map();
  for (const s of stocks) { const k = String(s.ingredientId); if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
  let rows = ings.map((i) => {
    const list = by.get(String(i._id)) || []; const qty = round4(list.reduce((t, s) => t + s.quantity, 0));
    return { ingredientId: i._id, name: i.name, sku: i.sku, baseUnit: i.baseUnit, quantity: qty, byLocation: list.map((s) => ({ branchId: s.branchId, location: s.location, quantity: round4(s.quantity) })), costPerBase: i.costPerBase, value: fromCents(Math.round(Math.max(0, qty) * (i.costPerBase || 0))), lowStockLevel: i.lowStockLevel, low: i.lowStockLevel > 0 && qty <= i.lowStockLevel, negative: qty < 0 };
  });
  if (lowOnly) rows = rows.filter((r) => r.low || r.negative);
  const total = rows.length;
  return { ...C.paged(rows.slice((page - 1) * limit, page * limit), total, { page, limit }), totalValue: fromCents(rows.reduce((s, r) => s + Math.round(r.value * 100), 0)) };
}

async function listMovements(businessId, user, { branchId, ingredientId, type, from, to, page = 1, limit = 50 }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (ingredientId) f.ingredientId = ingredientId; if (type) f.type = type;
  if (from || to) { f.createdAt = {}; if (from) f.createdAt.$gte = new Date(from); if (to) f.createdAt.$lte = new Date(to); }
  const [items, total] = await Promise.all([IngredientMovement.find(f).populate('ingredientId', 'name baseUnit').populate('performedBy', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), IngredientMovement.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}

const expiringBatches = (businessId, user, q) => require('./ingredientBatch.service').listExpiring(businessId, user, q);

/** Replenishment: anything at/below its reorder level, with a suggested quantity up to the par level and days of cover from the last 14 days of use. */
async function replenishmentSuggestions(businessId, user, { branchId }) {
  const scope = C.branchScope(user, branchId);
  const [ings, stocks] = await Promise.all([Ingredient.find({ businessId, status: 'active' }), IngredientStock.find({ businessId, ...C.branchFilter(scope) })]);
  const qty = new Map();
  for (const s of stocks) qty.set(String(s.ingredientId), (qty.get(String(s.ingredientId)) || 0) + s.quantity);
  const since = new Date(Date.now() - 14 * 86400000);
  const use = await IngredientMovement.aggregate([{ $match: { businessId: ings[0]?.businessId || businessId, ...C.branchFilter(scope), type: 'CONSUMPTION', createdAt: { $gte: since } } }, { $group: { _id: '$ingredientId', used: { $sum: { $abs: '$quantity' } } } }]);
  const daily = new Map(use.map((u) => [String(u._id), u.used / 14]));
  const out = [];
  for (const i of ings) {
    const q = round4(qty.get(String(i._id)) || 0); const level = i.reorderLevel || i.lowStockLevel || 0;
    if (level <= 0 || q > level) continue;
    const par = i.parLevel || level * 2; const need = round4(Math.max(0, par - q));
    const pu = i.purchaseUnit && U.compatible(i.purchaseUnit, i.baseUnit) ? i.purchaseUnit : i.baseUnit;
    const d = daily.get(String(i._id)) || 0;
    out.push({ ingredientId: i._id, name: i.name, baseUnit: i.baseUnit, quantity: q, reorderLevel: level, parLevel: par, suggestedBase: need, suggested: U.convert(need, i.baseUnit, pu), suggestedUnit: pu, daysOfCover: d > 0 ? Math.round((Math.max(0, q) / d) * 10) / 10 : null, estimatedCost: fromCents(Math.round(need * (i.costPerBase || 0))), supplierId: i.supplierId });
  }
  return out.sort((a, b) => (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9));
}

/** Hourly job: write off expired batches (only for restaurants that left auto write-off on). */
const expirySweep = (businessId) => require('./ingredientBatch.service').expirySweep(businessId);

module.exports = {
  createIngredient, updateIngredient, listIngredients, getIngredient, toBaseFor, moveStock, drawBatches, consume, reverse, receivePurchase, listPurchases,
  transfer, recordWaste, adjustStock, startCount, submitCount, approveCount, cancelCount, getCount, listCounts, listStock, listMovements,
  expiringBatches, replenishmentSuggestions, expirySweep, effLocation,
};
