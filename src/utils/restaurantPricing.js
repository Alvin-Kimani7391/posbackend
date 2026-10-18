/**
 * Pure menu pricing / availability rules (no database). All money integer cents.
 * Precedence for the base price: branch override > order-type price > base price. Then variant, then a timed
 * price (happy hour / promotion) replaces or discounts it, then modifier deltas are added.
 */
const { inAnyWindow } = require('./restaurantTime');
const fail = (code, message) => { const e = new Error(message || code); e.code = code; return e; };

const TYPE_PRICE_KEY = { DINE_IN: 'dineIn', BAR_TAB: 'dineIn', ROOM_SERVICE: 'dineIn', COUNTER: 'dineIn', TAKEAWAY: 'takeaway', PICKUP: 'takeaway', DELIVERY: 'delivery' };

function branchEntry(item, branchId) { return (item.branchOverrides || []).find((b) => String(b.branchId) === String(branchId)); }

/** Is the item orderable right now at this branch (active, not sold out, inside its menu period)? Returns { ok, reason }. */
function availability(item, { branchId, now = new Date(), timeZone = 'Africa/Nairobi' } = {}) {
  if (item.status && item.status !== 'active') return { ok: false, reason: 'INACTIVE' };
  if (item.soldOut?.flag) return { ok: false, reason: 'SOLD_OUT' };
  const be = branchEntry(item, branchId);
  if (be && be.available === false) return { ok: false, reason: 'NOT_AVAILABLE_AT_BRANCH' };
  if (item.menuPeriods?.length && !inAnyWindow(now, timeZone, item.menuPeriods)) return { ok: false, reason: 'OUTSIDE_MENU_PERIOD' };
  return { ok: true };
}

function basePrice(item, { orderType, branchId, variantId }) {
  const be = branchEntry(item, branchId);
  const key = TYPE_PRICE_KEY[orderType];
  let price = item.basePrice;
  if (key && item.typePrices && typeof item.typePrices[key] === 'number') price = item.typePrices[key];
  if (be && typeof be.price === 'number') price = be.price; // an explicit branch price wins
  let variantName;
  if (variantId) {
    const v = (item.variants || []).find((x) => String(x._id) === String(variantId));
    if (!v || v.active === false) throw fail('VARIANT_NOT_FOUND', 'Variant not found');
    variantName = v.name;
    if (typeof v.price === 'number') price = v.price + (v.priceDelta || 0); else price += v.priceDelta || 0;
  } else if ((item.variants || []).filter((v) => v.active !== false).length && item.requireVariant) {
    throw fail('VARIANT_REQUIRED', `${item.name}: choose a size / variant`);
  }
  return { price, variantName };
}

/** Applies the best matching timed price (happy hour). Returns { price, label }. */
function timedPrice(item, price, { branchId, now, timeZone }) {
  let best = { price, label: null };
  for (const t of item.timedPrices || []) {
    if (t.branchIds?.length && !t.branchIds.some((b) => String(b) === String(branchId))) continue;
    if (!inAnyWindow(now, timeZone, t.windows)) continue;
    const p = typeof t.price === 'number' ? t.price : Math.round(price * (1 - (t.percentOff || 0) / 100));
    if (p < best.price) best = { price: Math.max(0, p), label: t.label || 'Promotion' };
  }
  return best;
}

/**
 * Validates chosen modifier options against the item's groups (required, min, max, quantity) and returns
 * the snapshot lines. selections = [{ groupId, optionId, quantity? }]
 */
function resolveModifiers(item, groups, selections = []) {
  const byGroup = new Map();
  for (const s of selections) {
    const g = groups.find((x) => String(x._id) === String(s.groupId));
    if (!g || !(item.modifierGroupIds || []).some((id) => String(id) === String(g._id))) throw fail('MODIFIER_GROUP_INVALID', 'That option group does not belong to this item');
    const o = (g.options || []).find((x) => String(x._id) === String(s.optionId));
    if (!o || o.active === false) throw fail('MODIFIER_OPTION_INVALID', 'Option not found');
    if (o.soldOut) throw fail('MODIFIER_SOLD_OUT', `${o.name} is sold out`);
    const q = s.quantity || 1;
    if (!byGroup.has(String(g._id))) byGroup.set(String(g._id), { g, picked: [] });
    byGroup.get(String(g._id)).picked.push({ o, q });
  }
  const lines = [];
  for (const gid of item.modifierGroupIds || []) {
    const g = groups.find((x) => String(x._id) === String(gid));
    if (!g || g.active === false) continue;
    const entry = byGroup.get(String(gid)) || { g, picked: [] };
    const count = entry.picked.reduce((s, p) => s + p.q, 0);
    const min = g.required ? Math.max(1, g.min || 0) : (g.min || 0);
    if (count < min) throw fail('MODIFIER_MIN', `${g.name}: choose at least ${min}`);
    if (g.max && count > g.max) throw fail('MODIFIER_MAX', `${g.name}: choose at most ${g.max}`);
    for (const { o, q } of entry.picked) {
      if (q > 1 && !g.allowQuantity) throw fail('MODIFIER_QUANTITY', `${o.name}: quantity not allowed`);
      lines.push({
        groupId: g._id, optionId: o._id, groupName: g.name, name: o.name, quantity: q, priceDelta: o.priceDelta || 0,
        costDelta: o.costDelta || 0, allergens: o.allergens || [], substitution: !!o.substitution, ingredientLines: o.ingredientLines || [],
        removal: !!o.removal,
      });
    }
  }
  return lines;
}

/** Does this selection change cost or allergens through a substitution (needs the substitute permission)? */
const needsSubstitutionApproval = (mods) => mods.some((m) => m.substitution && (m.priceDelta !== 0 || m.costDelta !== 0 || (m.allergens || []).length > 0));

/** Full unit price: base -> variant -> timed -> modifiers. */
function priceItem(item, groups, { orderType, branchId, variantId, modifiers = [], now = new Date(), timeZone = 'Africa/Nairobi' }) {
  const av = availability(item, { branchId, now, timeZone });
  if (!av.ok) throw fail(av.reason, `${item.name} is not available (${av.reason.toLowerCase().replace(/_/g, ' ')})`);
  const { price: base, variantName } = basePrice(item, { orderType, branchId, variantId });
  const timed = timedPrice(item, base, { branchId, now, timeZone });
  const mods = resolveModifiers(item, groups, modifiers);
  const modTotal = mods.reduce((s, m) => s + m.priceDelta * m.quantity, 0);
  return { unitPrice: Math.max(0, timed.price + modTotal), basePrice: base, variantName, promoLabel: timed.label, modifiers: mods, substitutionApproval: needsSubstitutionApproval(mods) };
}

/** Combo: validates picked components against comboGroups (min/max) and returns the chosen menu item ids with price deltas. */
function resolveCombo(item, picks = []) {
  const out = [];
  for (const g of item.comboGroups || []) {
    const chosen = picks.filter((p) => String(p.groupId) === String(g._id));
    const n = chosen.reduce((s, p) => s + (p.quantity || 1), 0);
    if (n < (g.min ?? 1)) throw fail('COMBO_MIN', `${g.name}: choose at least ${g.min ?? 1}`);
    if (g.max && n > g.max) throw fail('COMBO_MAX', `${g.name}: choose at most ${g.max}`);
    for (const p of chosen) {
      const opt = (g.options || []).find((o) => String(o.menuItemId) === String(p.menuItemId));
      if (!opt) throw fail('COMBO_OPTION_INVALID', `${g.name}: option not allowed`);
      out.push({ groupName: g.name, menuItemId: opt.menuItemId, quantity: p.quantity || 1, priceDelta: opt.priceDelta || 0, variantId: p.variantId });
    }
  }
  if (picks.some((p) => !out.find((o) => String(o.menuItemId) === String(p.menuItemId) && String(o.groupName) === String((item.comboGroups.find((g) => String(g._id) === String(p.groupId)) || {}).name)))) throw fail('COMBO_OPTION_INVALID', 'Invalid combo selection');
  return out;
}

module.exports = { availability, basePrice, timedPrice, resolveModifiers, needsSubstitutionApproval, priceItem, resolveCombo, TYPE_PRICE_KEY };
