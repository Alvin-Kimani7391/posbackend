/** Menu management: modifier groups, menu items (each backed by a Product so invoices/eTIMS/CRM work), sold-out, waiter menu. */
const MenuItem = require('../../models/MenuItem');
const ModifierGroup = require('../../models/ModifierGroup');
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const Recipe = require('../../models/Recipe');
const IngredientStock = require('../../models/IngredientStock');
const AuditLog = require('../../models/AuditLog');
const ApiError = require('../../utils/ApiError');
const { nextSequence, pad } = require('../../models/Counter');
const { MENU_SKU_PREFIX } = require('../../constants/restaurant');
const P = require('../../utils/restaurantPricing');
const { portionsPossible } = require('../../utils/restaurantRecipe');
const recipeSvc = require('./recipe.service');
const C = require('./common');

// ---------------- modifier groups
const listGroups = (businessId) => ModifierGroup.find({ businessId, active: true }).sort({ name: 1 });
async function createGroup(businessId, userId, input) { const g = await ModifierGroup.create({ ...input, businessId }); await C.audit({ businessId, userId, action: 'restaurant.modifier.create', entityType: 'ModifierGroup', entityId: g._id, newValue: { name: g.name } }); return g; }
async function updateGroup(businessId, userId, id, input) {
  const g = await ModifierGroup.findOne({ _id: id, businessId }); if (!g) throw ApiError.notFound('Option group not found');
  Object.assign(g, input); await g.save(); await C.audit({ businessId, userId, action: 'restaurant.modifier.update', entityType: 'ModifierGroup', entityId: g._id }); return g;
}
async function archiveGroup(businessId, userId, id) {
  const g = await ModifierGroup.findOne({ _id: id, businessId }); if (!g) throw ApiError.notFound('Option group not found');
  g.active = false; await g.save(); await MenuItem.updateMany({ businessId }, { $pull: { modifierGroupIds: g._id } }); return g;
}

// ---------------- menu items
async function checkRefs(businessId, input) {
  if (input.categoryId && !(await Category.exists({ _id: input.categoryId, businessId }))) throw ApiError.badRequest('Category not found', 'CATEGORY_NOT_FOUND');
  if (input.modifierGroupIds?.length) { const n = await ModifierGroup.countDocuments({ businessId, _id: { $in: input.modifierGroupIds } }); if (n !== new Set(input.modifierGroupIds.map(String)).size) throw ApiError.badRequest('An option group was not found', 'MODIFIER_GROUP_NOT_FOUND'); }
  if (input.comboGroups?.length) {
    const ids = input.comboGroups.flatMap((g) => g.options.map((o) => String(o.menuItemId)));
    const n = await MenuItem.countDocuments({ businessId, _id: { $in: ids }, isCombo: false, status: 'active' });
    if (n !== new Set(ids).size) throw ApiError.badRequest('Combo components must be active, non-combo menu items', 'COMBO_COMPONENT_INVALID');
  }
}

/** A recipe typed into the menu item form: only when the restaurant tracks ingredients by recipe. */
function assertRecipesOn(ctx) {
  if (!ctx.features.recipes) throw ApiError.badRequest('Ingredient tracking by recipe is switched off. Turn it on in the restaurant tracking settings first.', 'RECIPES_DISABLED');
}

async function createItem(businessId, userId, fullInput) {
  const { recipe, ...input } = fullInput;
  await checkRefs(businessId, input);
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    if (recipe) { assertRecipesOn(ctx); if (input.stockMode === 'PRODUCT') throw ApiError.badRequest('A dish linked to a stocked product cannot also have a recipe', 'STOCK_MODE_PRODUCT'); }
    const taxRate = input.taxRate ?? ctx.defaultTaxRate;
    let productId = input.productId; let ownsProduct = false;
    if (input.stockMode === 'PRODUCT') {
      const p = await Product.findOne({ _id: productId, businessId, status: 'active' }).session(session);
      if (!p) throw ApiError.badRequest('Link a stocked product for stock mode PRODUCT', 'PRODUCT_NOT_FOUND');
      if (!p.trackInventory) throw ApiError.badRequest('That product does not track inventory', 'PRODUCT_NOT_TRACKED');
    } else {
      const seq = await nextSequence(businessId, 'menuitem', session);
      const [p] = await Product.create([{ businessId, name: input.name, sku: `${MENU_SKU_PREFIX}${pad(seq)}`, description: input.description || 'Restaurant menu item', productType: 'service', unit: 'piece', trackInventory: false, costPrice: 0, sellingPrice: input.basePrice, taxRate, categoryId: input.categoryId, image: input.image, status: 'active', createdBy: userId }], { session });
      productId = p._id; ownsProduct = true;
    }
    const { productId: _ignored, ...rest } = input;
    const [item] = await MenuItem.create([{ ...rest, taxRate, businessId, productId, ownsProduct, createdBy: userId }], { session });
    await C.audit({ businessId, userId, action: 'restaurant.menu.create', entityType: 'MenuItem', entityId: item._id, newValue: { name: item.name, basePrice: item.basePrice } }, session);
    if (recipe) { await recipeSvc.createVersionIn(session, businessId, userId, { ...recipe, menuItemId: item._id }); return MenuItem.findById(item._id).session(session); }
    return item;
  });
}

async function updateItem(businessId, userId, id, fullInput) {
  const { recipe, ...input } = fullInput;
  await checkRefs(businessId, input);
  return C.inTx(async (session) => {
    if (recipe) assertRecipesOn(await C.getContext(businessId, session));
    const item = await MenuItem.findOne({ _id: id, businessId }).session(session);
    if (!item) throw ApiError.notFound('Menu item not found', 'MENU_ITEM_NOT_FOUND');
    const before = { basePrice: item.basePrice, typePrices: item.typePrices?.toObject?.({ transform: false }), variants: item.variants.map((v) => ({ name: v.name, price: v.price, priceDelta: v.priceDelta })) };
    const { productId, ...rest } = input;
    if (rest.stockMode && rest.stockMode !== item.stockMode && item.stockMode === 'PRODUCT') throw ApiError.badRequest('Create a new menu item to change away from a linked product', 'STOCK_MODE_LOCKED');
    Object.assign(item, rest, { updatedBy: userId });
    await item.save({ session });
    const priceChanged = before.basePrice !== item.basePrice || JSON.stringify(before.typePrices) !== JSON.stringify(item.typePrices?.toObject?.({ transform: false })) || JSON.stringify(before.variants) !== JSON.stringify(item.variants.map((v) => ({ name: v.name, price: v.price, priceDelta: v.priceDelta })));
    if (item.ownsProduct) await Product.updateOne({ _id: item.productId, businessId }, { $set: { name: item.name, sellingPrice: item.basePrice, taxRate: item.taxRate, categoryId: item.categoryId, image: item.image } }, { session });
    if (priceChanged) await C.audit({ businessId, userId, action: 'restaurant.menu.price_change', entityType: 'MenuItem', entityId: item._id, oldValue: before, newValue: { basePrice: item.basePrice, typePrices: item.typePrices?.toObject?.({ transform: false }), variants: item.variants.map((v) => ({ name: v.name, price: v.price, priceDelta: v.priceDelta })) } }, session);
    else await C.audit({ businessId, userId, action: 'restaurant.menu.update', entityType: 'MenuItem', entityId: item._id }, session);
    if (recipe) { await recipeSvc.createVersionIn(session, businessId, userId, { ...recipe, menuItemId: item._id }); return MenuItem.findById(item._id).session(session); }
    if (recipe === null) { await recipeSvc.clearRecipe(businessId, userId, item._id, session); return MenuItem.findById(item._id).session(session); }
    return item;
  });
}

async function archiveItem(businessId, userId, id) {
  const item = await MenuItem.findOne({ _id: id, businessId }); if (!item) throw ApiError.notFound('Menu item not found', 'MENU_ITEM_NOT_FOUND');
  item.status = 'archived'; await item.save();
  if (item.ownsProduct) await Product.updateOne({ _id: item.productId, businessId }, { $set: { status: 'archived' } });
  await C.audit({ businessId, userId, action: 'restaurant.menu.archive', entityType: 'MenuItem', entityId: item._id });
  return item;
}

async function setSoldOut(businessId, user, id, { soldOut, reason }) {
  const item = await MenuItem.findOne({ _id: id, businessId }); if (!item) throw ApiError.notFound('Menu item not found', 'MENU_ITEM_NOT_FOUND');
  item.soldOut = soldOut ? { flag: true, reason, by: user._id, at: new Date() } : { flag: false };
  await item.save();
  await C.audit({ businessId, userId: user._id, action: soldOut ? 'restaurant.menu.soldout' : 'restaurant.menu.available', entityType: 'MenuItem', entityId: item._id, newValue: { reason } });
  if (soldOut) {
    C.notifyRoles(businessId, undefined, [...C.FLOOR_LEAD_ROLES, 'WAITER', 'BARTENDER', 'CASHIER'], { type: 'MENU_SOLD_OUT', title: `Sold out: ${item.name}`, message: `${item.name} is sold out${reason ? ` (${reason})` : ''}. Do not take new orders for it.`, entityType: 'MenuItem', entityId: item._id });
  }
  return item;
}

const getItem = async (businessId, id) => { const i = await MenuItem.findOne({ _id: id, businessId }); if (!i) throw ApiError.notFound('Menu item not found', 'MENU_ITEM_NOT_FOUND'); return i; };

async function listItems(businessId, { categoryId, search, status = 'active', page = 1, limit = 50 }) {
  const f = { businessId, status }; if (categoryId) f.categoryId = categoryId; if (search) f.name = new RegExp(C.escapeRegex(search), 'i');
  const [items, total] = await Promise.all([MenuItem.find(f).sort({ sortOrder: 1, name: 1 }).skip((page - 1) * limit).limit(limit), MenuItem.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}

const priceHistory = (businessId, id) => AuditLog.find({ businessId, entityType: 'MenuItem', entityId: id, action: 'restaurant.menu.price_change' }).sort({ timestamp: -1 }).limit(100);

/**
 * The waiter's menu: every active item with the price it will actually be charged right now for this order type and branch,
 * whether it can be ordered, and (when recipes are on) how many portions the ingredients allow.
 */
// Short-lived cache: the menu is rebuilt for every table, waiter and QR scan otherwise. Cleared on every menu write; 10 s max otherwise.
const MENU_TTL = 10000; const menuCache = new Map();
const bustMenu = (businessId) => { const p = String(businessId) + ':'; for (const k of menuCache.keys()) if (k.startsWith(p)) menuCache.delete(k); try { require('../tv/tv.service').menuChanged(businessId); } catch (e) { /* TV refresh is best-effort */ } };
async function getMenu(businessId, user, { branchId, orderType = 'DINE_IN', now } = {}) {
  C.assertBranchAccess(user, branchId);
  const key = `${businessId}:${branchId}:${orderType}`; const hit = menuCache.get(key);
  if (!now && hit && Date.now() - hit.t < MENU_TTL) return hit.v;
  const v = await buildMenu(businessId, user, { branchId, orderType, now: now || new Date() });
  if (!now) { if (menuCache.size > 200) menuCache.clear(); menuCache.set(key, { t: Date.now(), v }); }
  return v;
}
async function buildMenu(businessId, user, { branchId, orderType = 'DINE_IN', now = new Date() }) {
  const ctx = await C.getContext(businessId);
  const [items, groups, cats] = await Promise.all([MenuItem.find({ businessId, status: 'active' }).sort({ sortOrder: 1, name: 1 }), ModifierGroup.find({ businessId, active: true }), Category.find({ businessId, status: 'active' }).sort({ name: 1 })]);
  let portions = new Map();
  if (ctx.features.recipes) {
    const recipes = await Recipe.find({ businessId, isCurrent: true, menuItemId: { $in: items.map((i) => i._id) } });
    const stocks = await IngredientStock.aggregate([{ $match: { businessId: items[0]?.businessId || businessId, branchId: C.oid(branchId) } }, { $group: { _id: '$ingredientId', q: { $sum: '$quantity' } } }]);
    const sm = new Map(stocks.map((s) => [String(s._id), s.q]));
    for (const r of recipes) portions.set(String(r.menuItemId), portionsPossible(r.lines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.quantity / (r.yieldPortions || 1) })), sm));
  }
  const gById = new Map(groups.map((g) => [String(g._id), g]));
  const out = items.map((it) => {
    const av = P.availability(it, { branchId, now, timeZone: ctx.timeZone });
    let price = null; let promo = null;
    try { const bp = P.basePrice(it, { orderType, branchId }); const t = P.timedPrice(it, bp.price, { branchId, now, timeZone: ctx.timeZone }); price = t.price; promo = t.label; } catch (e) { /* variant required: price shown per variant */ }
    const p = portions.get(String(it._id));
    let available = av.ok; let reason = av.reason;
    if (available && p === 0 && ctx.settings.hideOutOfStockItems) { available = false; reason = 'OUT_OF_STOCK'; }
    return { ...it.toJSON(), effectivePrice: price === null ? null : price / 100, promoLabel: promo, available, unavailableReason: available ? undefined : reason, portionsLeft: p === undefined || p === Infinity ? undefined : p, modifierGroups: (it.modifierGroupIds || []).map((g) => gById.get(String(g))).filter(Boolean) };
  });
  const byCat = new Map();
  for (const i of out) { const k = String(i.categoryId || 'none'); if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(i); }
  const categories = cats.filter((c) => byCat.has(String(c._id))).map((c) => ({ _id: c._id, name: c.name, items: byCat.get(String(c._id)) }));
  if (byCat.has('none')) categories.push({ _id: null, name: 'Other', items: byCat.get('none') });
  return { branchId, orderType, generatedAt: now, categories };
}

const writes = { createGroup, updateGroup, archiveGroup, createItem, updateItem, archiveItem, setSoldOut };
for (const k of Object.keys(writes)) { const fn = writes[k]; writes[k] = async (businessId, ...a) => { try { return await fn(businessId, ...a); } finally { bustMenu(businessId); } }; }
module.exports = { listGroups, ...writes, getItem, listItems, priceHistory, getMenu, bustMenu };