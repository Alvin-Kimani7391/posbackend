/**
 * Ingredient / product depletion for order items. The caller loads the order inside a transaction, calls these, and saves the order
 * in the SAME transaction, so stock and item.stockState commit or roll back together (no partial or double deduction; a retried
 * request finds stockState already DEDUCTED and does nothing).
 */
const Recipe = require('../../models/Recipe');
const WasteRecord = require('../../models/WasteRecord');
const { applyStockChange } = require('../inventory.service');
const { consumption } = require('../../utils/restaurantRecipe');
const { NOT_STARTED_STATUS } = require('../../constants/restaurant');
const ingredients = require('./ingredient.service');

const EVENT_ORDER = ['ON_SEND', 'ON_READY', 'ON_ORDER_CLOSE'];
const wasPrepared = (item) => ['PREPARING', 'READY', 'SERVED'].includes(item.status);

function dueNow(item, event, settings) {
  if (item.stockMode === 'NONE' || item.stockState !== 'NONE') return false;
  if (['DRAFT', 'HELD', 'CANCELLED'].includes(item.status)) return false;
  if (event === 'ON_ORDER_CLOSE') return true;                       // catch-all: anything never deducted is deducted when the order closes
  return settings.stockDepletionEvent === event && EVENT_ORDER.includes(event);
}

async function deplete(order, item, { ctx, userId, session, movementType, reason }) {
  const ref = { referenceType: 'RestaurantOrder', referenceId: order._id };
  if (item.stockMode === 'PRODUCT') {
    await applyStockChange({ businessId: order.businessId, branchId: order.branchId, productId: item.productId, variantId: null, quantityDelta: -item.quantity, type: movementType === 'WASTE' ? 'DAMAGE' : 'SALE', ...ref, reason: reason || `Order ${order.orderNumber}`, performedBy: userId, session, allowNegative: !!ctx.business.settings?.allowNegativeStock || ctx.settings.allowNegativeIngredients !== false });
    item.stockState = 'DEDUCTED'; item.stockLines = []; return;
  }
  if (!ctx.features.recipes || !item.recipeId) { item.stockState = 'NONE'; return; }   // recipes switched off or no recipe yet: nothing to deduct
  const recipe = await Recipe.findById(item.recipeId).session(session);
  if (!recipe) return;
  const lines = consumption(recipe, { quantity: item.quantity, portionMultiplier: item.portionMultiplier || 1, modifiers: item.modifiers });
  const type = movementType || (item.isComplimentary ? (item.compKind === 'STAFF_MEAL' ? 'STAFF_MEAL' : 'COMPLIMENTARY') : 'CONSUMPTION');
  const location = item.stationType === 'BAR' ? 'BAR' : 'KITCHEN';
  item.stockLines = await ingredients.consume({ businessId: order.businessId, branchId: order.branchId, lines, location, type, ...ref, reason: reason || `Order ${order.orderNumber}: ${item.name}`, userId, session, ctx });
  item.stockState = 'DEDUCTED';
}

/** Deducts every item that is due for this event. Mutates the order's items. */
async function depleteDue(order, event, { ctx, userId, session, onlyIds }) {
  for (const item of order.items) {
    if (onlyIds && !onlyIds.some((i) => String(i) === String(item._id))) continue;
    if (dueNow(item, event, ctx.settings)) await deplete(order, item, { ctx, userId, session });
  }
}

/** An item is being cancelled. Before preparation the stock goes back; after, it is recorded as waste. */
async function settleCancelledItem(order, item, { ctx, userId, session, reason }) {
  const ref = { referenceType: 'RestaurantOrder', referenceId: order._id };
  const prepared = wasPrepared(item);
  if (item.stockMode === 'NONE') return { wasted: false };
  if (item.stockState === 'DEDUCTED' && !prepared) {
    if (item.stockMode === 'PRODUCT') await applyStockChange({ businessId: order.businessId, branchId: order.branchId, productId: item.productId, variantId: null, quantityDelta: item.quantity, type: 'RETURN', ...ref, reason: `Order ${order.orderNumber}: ${item.name} cancelled before preparation`, performedBy: userId, session, allowNegative: true });
    else await ingredients.reverse({ businessId: order.businessId, branchId: order.branchId, stockLines: item.stockLines, ...ref, reason: `Order ${order.orderNumber}: ${item.name} cancelled before preparation`, userId, session });
    item.stockState = 'REVERSED'; return { wasted: false };
  }
  if (prepared) {
    if (item.stockState === 'NONE') await deplete(order, item, { ctx, userId, session, movementType: 'WASTE', reason: `Order ${order.orderNumber}: ${item.name} voided after preparation` });
    if (item.stockState === 'DEDUCTED') {
      item.stockState = 'WASTED';
      await WasteRecord.create([{ businessId: order.businessId, branchId: order.branchId, kind: 'VOID_AFTER_PREP', menuItemId: item.menuItemId, orderId: order._id, orderItemId: item._id, name: item.name, quantity: item.quantity, cost: Math.round((item.costUnit || 0) * item.quantity), reason, recordedBy: userId }], { session });
      return { wasted: true };
    }
  }
  return { wasted: false };
}

module.exports = { deplete, depleteDue, settleCancelledItem, dueNow, wasPrepared, NOT_STARTED_STATUS };
