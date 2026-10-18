/** Pure recipe maths: what a sold dish consumes, and what it costs. Quantities are in each ingredient's BASE unit. */
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

/**
 * consumption(recipe, { quantity, portionMultiplier, modifiers }) -> [{ ingredientId, quantity }]
 *  - listed quantity / yieldPortions, grossed up for preparation loss (quantity / (1 - loss%))
 *  - x portions sold x the variant's portion multiplier
 *  - modifier options add or remove ingredients (signed lines) per portion; a total below zero is clamped to zero
 */
function consumption(recipe, { quantity = 1, portionMultiplier = 1, modifiers = [] } = {}) {
  const per = new Map();
  const add = (id, q) => { const k = String(id); per.set(k, (per.get(k) || 0) + q); };
  const yieldP = recipe?.yieldPortions > 0 ? recipe.yieldPortions : 1;
  for (const l of recipe?.lines || []) {
    const loss = Math.min(95, Math.max(0, l.prepLossPercent || 0));
    add(l.ingredientId, ((l.quantity / yieldP) / (1 - loss / 100)) * portionMultiplier * quantity);
  }
  for (const m of modifiers) for (const il of m.ingredientLines || []) add(il.ingredientId, il.quantity * (m.quantity || 1) * quantity);
  const out = [];
  for (const [id, q] of per) { const r = round4(Math.max(0, q)); if (r > 0) out.push({ ingredientId: id, quantity: r }); }
  return out;
}

/** Cost in cents of consuming those lines. costMap: Map(ingredientId -> cents per base unit). */
function costOf(lines, costMap) {
  return Math.round(lines.reduce((s, l) => s + l.quantity * (costMap.get(String(l.ingredientId)) || 0), 0));
}

/** How many portions the given stock supports. stockMap: Map(ingredientId -> base qty available). */
function portionsPossible(recipeLines, stockMap) {
  if (!recipeLines.length) return Infinity;
  return Math.max(0, Math.floor(Math.min(...recipeLines.map((l) => (stockMap.get(String(l.ingredientId)) || 0) / l.quantity))));
}

module.exports = { consumption, costOf, portionsPossible, round4 };
