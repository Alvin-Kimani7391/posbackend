/**
 * Ingredient tracking by recipe: the owner's on/off switch and a readiness check.
 *   OFF  orders never touch ingredient stock; recipe/ingredient screens are closed; the profit & loss counts food cost from PURCHASES
 *        (expenses recorded as "Food Purchases"). Nothing is deleted when it is turned off.
 *   ON   every dish with a recipe takes its ingredients out of stock when sold (batches, first-expiring first), ingredient purchases build cost,
 *        expiry feeds the daily alert, and the profit & loss counts the real cost of what was sold + wastage.
 * The switch is the business feature flag `recipeManagement`, so it takes effect on the very next request.
 */
const Business = require('../../models/Business');
const MenuItem = require('../../models/MenuItem');
const Recipe = require('../../models/Recipe');
const Ingredient = require('../../models/Ingredient');
const IngredientBatch = require('../../models/IngredientBatch');
const ApiError = require('../../utils/ApiError');
const batches = require('./ingredientBatch.service');
const settingsSvc = require('./settings.service');
const menu = require('./menu.service');
const C = require('./common');

async function getStatus(businessId) {
  const ctx = await C.getContext(businessId);
  const [dishes, withRecipe, ings, noCost, batchTracked, activeBatches] = await Promise.all([
    MenuItem.countDocuments({ businessId, status: 'active', isCombo: { $ne: true }, stockMode: { $ne: 'PRODUCT' } }),
    Recipe.distinct('menuItemId', { businessId, isCurrent: true }),
    Ingredient.countDocuments({ businessId, status: 'active' }),
    Ingredient.countDocuments({ businessId, status: 'active', costPerBase: { $lte: 0 } }),
    Ingredient.countDocuments({ businessId, status: 'active', trackBatch: true }),
    IngredientBatch.countDocuments({ businessId, status: 'ACTIVE', quantity: { $gt: 0 } }),
  ]);
  const enabled = ctx.features.recipes;
  const expiry = enabled ? await batches.expirySummary(businessId) : null;
  const checklist = [
    { key: 'ingredients', done: ings > 0, label: 'Add your ingredients' },
    { key: 'costs', done: ings > 0 && noCost === 0, label: 'Every ingredient has a cost (set it or receive a purchase)' },
    { key: 'recipes', done: withRecipe.length > 0, label: 'Add a recipe to your dishes' },
    { key: 'stock', done: activeBatches > 0 || ings > 0, label: 'Receive ingredient stock so deductions are accurate' },
  ];
  return {
    enabled, ordering: ctx.features.ordering, tracking: ctx.settings.tracking, costBasis: ctx.settings.tracking?.costBasis || 'AUTO',
    dishes: { total: dishes, withRecipe: withRecipe.length, withoutRecipe: Math.max(0, dishes - withRecipe.length) },
    ingredients: { total: ings, withoutCost: noCost, batchTracked, activeBatches },
    expiry: expiry && { criticalDays: expiry.criticalDays, warningDays: expiry.warningDays, expired: expiry.expired.batches, critical: expiry.critical.batches, warning: expiry.warning.batches },
    checklist,
  };
}

async function setTracking(businessId, userId, { enabled, tracking }) {
  const ctx = await C.getContext(businessId);
  if (enabled === true && !ctx.features.ordering) throw ApiError.badRequest('Switch the restaurant module on first', 'RESTAURANT_DISABLED');
  if (tracking) {
    const t = { ...(ctx.settings.tracking?.toObject?.() || ctx.settings.tracking || {}), ...tracking };
    if ((t.expiryWarningDays ?? 7) < (t.expiryCriticalDays ?? 3)) throw ApiError.badRequest('The warning period must be at least as long as the critical period', 'BAD_THRESHOLDS');
    await settingsSvc.updateSettings(businessId, userId, { tracking });
  }
  if (typeof enabled === 'boolean' && enabled !== ctx.features.recipes) {
    const set = { 'featureSettings.recipeManagement': enabled };
    if (enabled) set['featureSettings.batchTracking'] = true;
    await Business.updateOne({ _id: businessId }, { $set: set });
    require('../../utils/businessContext').invalidateBusinessContext(businessId);
    menu.bustMenu(businessId);
    await C.audit({ businessId, userId, action: enabled ? 'restaurant.tracking.on' : 'restaurant.tracking.off', entityType: 'Business', entityId: businessId });
  }
  return getStatus(businessId);
}

module.exports = { getStatus, setTracking };
