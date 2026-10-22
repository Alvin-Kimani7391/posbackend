/** Versioned recipes and costing. An edit creates a new version; historical orders keep the version in force when they were sold. */
const Recipe = require('../../models/Recipe');
const MenuItem = require('../../models/MenuItem');
const Ingredient = require('../../models/Ingredient');
const ApiError = require('../../utils/ApiError');
const U = require('../../utils/restaurantUnits');
const { consumption, costOf } = require('../../utils/restaurantRecipe');
const { fromCents } = require('../../utils/money');
const C = require('./common');

async function costMapFor(businessId, ingredientIds, session) {
  const ings = await C.withSession(Ingredient.find({ businessId, _id: { $in: ingredientIds } }).select('costPerBase name baseUnit'), session);
  return { map: new Map(ings.map((i) => [String(i._id), i.costPerBase || 0])), ings: new Map(ings.map((i) => [String(i._id), i])) };
}

const current = (businessId, menuItemId, session) => C.withSession(Recipe.findOne({ businessId, menuItemId, isCurrent: true }), session);

/** Saves a new recipe version INSIDE the caller's transaction (menu.service uses it to save a dish and its recipe together). */
async function createVersionIn(session, businessId, userId, { menuItemId, lines, yieldPortions = 1, changeNote }) {
  {
    const item = await MenuItem.findOne({ _id: menuItemId, businessId }).session(session);
    if (!item) throw ApiError.notFound('Menu item not found', 'MENU_ITEM_NOT_FOUND');
    if (item.stockMode === 'PRODUCT') throw ApiError.badRequest('This item deducts a stocked product, not ingredients. Change its stock mode first.', 'STOCK_MODE_PRODUCT');
    const { map, ings } = await costMapFor(businessId, lines.map((l) => l.ingredientId), session);
    const built = lines.map((l) => {
      const ing = ings.get(String(l.ingredientId));
      if (!ing) throw ApiError.badRequest('Ingredient not found', 'INGREDIENT_NOT_FOUND');
      const unit = l.unit || ing.baseUnit;
      if (!U.isUnit(unit) || U.baseUnitFor(unit) !== ing.baseUnit) throw ApiError.badRequest(`${ing.name} is measured in ${ing.baseUnit}; "${unit}" is not compatible`, 'UNIT_INCOMPATIBLE');
      return { ingredientId: ing._id, quantity: U.toBase(l.quantity, unit), displayQuantity: l.quantity, displayUnit: unit, prepLossPercent: l.prepLossPercent || 0, optional: !!l.optional };
    });
    const ids = built.map((b) => String(b.ingredientId));
    if (new Set(ids).size !== ids.length) throw ApiError.badRequest('An ingredient is listed twice in the recipe', 'DUPLICATE_INGREDIENT');
    const last = await Recipe.findOne({ businessId, menuItemId }).sort({ version: -1 }).session(session);
    const draft = { lines: built, yieldPortions };
    const cost = costOf(consumption(draft), map);
    await Recipe.updateMany({ businessId, menuItemId, isCurrent: true }, { $set: { isCurrent: false } }, { session });
    const [recipe] = await Recipe.create([{ businessId, menuItemId, version: (last?.version || 0) + 1, isCurrent: true, yieldPortions, lines: built, costPerPortion: cost, changeNote, createdBy: userId }], { session });
    const upd = { costCents: cost }; if (item.stockMode === 'NONE') upd.stockMode = 'RECIPE';
    await MenuItem.updateOne({ _id: item._id }, { $set: upd }, { session });
    await C.audit({ businessId, userId, action: 'recipe.version', entityType: 'MenuItem', entityId: item._id, newValue: { version: recipe.version, costPerPortion: cost } }, session);
    return recipe;
  }
}

const createVersion = (businessId, userId, input) => C.inTx((session) => createVersionIn(session, businessId, userId, input));

/** Takes the recipe off a dish (it stops deducting ingredients). Old versions stay for history; orders already placed keep their version. */
async function clearRecipe(businessId, userId, menuItemId, session) {
  const item = await MenuItem.findOne({ _id: menuItemId, businessId }).session(session);
  if (!item || item.stockMode !== 'RECIPE') return;
  await Recipe.updateMany({ businessId, menuItemId, isCurrent: true }, { $set: { isCurrent: false } }, { session });
  await MenuItem.updateOne({ _id: item._id }, { $set: { stockMode: 'NONE', costCents: 0 } }, { session });
  await C.audit({ businessId, userId, action: 'recipe.clear', entityType: 'MenuItem', entityId: item._id }, session);
}

async function history(businessId, menuItemId) {
  return Recipe.find({ businessId, menuItemId }).sort({ version: -1 }).populate('createdBy', 'name');
}

/** Cost breakdown at today's ingredient prices, with food-cost % against the menu price. */
async function costBreakdown(businessId, menuItemId, { variantId } = {}) {
  const item = await MenuItem.findOne({ _id: menuItemId, businessId });
  if (!item) throw ApiError.notFound('Menu item not found', 'MENU_ITEM_NOT_FOUND');
  const recipe = await current(businessId, menuItemId);
  if (!recipe) return { menuItemId, hasRecipe: false };
  const v = variantId ? item.variants.id(variantId) : null;
  const mult = v?.portionMultiplier || 1;
  const { map, ings } = await costMapFor(businessId, recipe.lines.map((l) => l.ingredientId));
  const lines = consumption(recipe, { quantity: 1, portionMultiplier: mult }).map((l) => {
    const ing = ings.get(String(l.ingredientId)); const cost = Math.round(l.quantity * (map.get(String(l.ingredientId)) || 0));
    return { ingredientId: l.ingredientId, name: ing?.name, quantity: l.quantity, unit: ing?.baseUnit, cost: fromCents(cost), _c: cost };
  });
  const total = lines.reduce((s, l) => s + l._c, 0);
  const price = v ? (typeof v.price === 'number' ? v.price + (v.priceDelta || 0) : item.basePrice + (v.priceDelta || 0)) : item.basePrice;
  const priceExTax = Math.round(price / (1 + (item.taxRate || 0) / 100));
  return {
    menuItemId, hasRecipe: true, version: recipe.version, lines: lines.map(({ _c, ...l }) => l), costPerPortion: fromCents(total), price: fromCents(price),
    foodCostPercent: priceExTax > 0 ? Math.round((total / priceExTax) * 1000) / 10 : null, grossProfitPerPortion: fromCents(priceExTax - total),
  };
}

/** After an ingredient's cost changes, refresh every current recipe that uses it and the menu item's estimated cost. */
async function refreshCosts(businessId, ingredientIds) {
  if (!ingredientIds?.length) return 0;
  const recipes = await Recipe.find({ businessId, isCurrent: true, 'lines.ingredientId': { $in: ingredientIds } });
  for (const r of recipes) {
    const { map } = await costMapFor(businessId, r.lines.map((l) => l.ingredientId));
    const cost = costOf(consumption(r), map);
    r.costPerPortion = cost; await r.save();
    await MenuItem.updateOne({ _id: r.menuItemId, businessId }, { $set: { costCents: cost } });
  }
  return recipes.length;
}

module.exports = { createVersion, createVersionIn, clearRecipe, current, history, costBreakdown, refreshCosts, costMapFor };
