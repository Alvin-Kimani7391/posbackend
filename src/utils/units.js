'use strict';
/**
 * units.js - unit conversion rules. Stock, batches and the ledger are ALWAYS in the product's BASE unit (Product.unit).
 * Product.units[] = other units; `factor` = BASE units in one of them (bundle of 24 packets -> factor 24).
 * Prices on a unit are for ONE such unit, integer cents. Pure functions + resolveUnit (throws ApiError).
 */
const ApiError = require('./ApiError');

const round3 = (n) => Math.round(n * 1000) / 1000;
const pos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

function resolveUnit(product, unitId) {
  if (!unitId) return { id: null, name: product.unit || 'piece', factor: 1, isBase: true, unit: null };
  const u = (product.units || []).find((x) => String(x._id) === String(unitId) && x.status !== 'inactive');
  if (!u) throw ApiError.badRequest(`Unit not found on ${product.name}`, 'UNIT_NOT_FOUND');
  return { id: u._id, name: u.name, factor: u.factor, isBase: false, unit: u };
}

const toBase = (qty, factor) => round3(qty * factor);

/** Price (cents) of ONE `unit` in WHOLESALE mode: unit.wholesalePrice, else wholesale-per-base x factor, else retail x factor. */
function wholesaleUnitPrice(product, variant, unit) {
  if (unit.unit && pos(unit.unit.wholesalePrice)) return unit.unit.wholesalePrice;
  const base = (variant && pos(variant.wholesalePrice)) ? variant.wholesalePrice : (pos(product.wholesalePrice) ? product.wholesalePrice : null);
  const perBase = base !== null ? base : (variant ? variant.sellingPrice : product.sellingPrice);
  return Math.round(perBase * unit.factor);
}

/** Price (cents) of ONE `unit` in RETAIL mode: unit.retailPrice, else retail price x factor. */
function retailUnitPrice(product, variant, unit) {
  if (unit.unit && pos(unit.unit.retailPrice)) return unit.unit.retailPrice;
  return Math.round((variant ? variant.sellingPrice : product.sellingPrice) * unit.factor);
}

/** Wholesale value of ONE base unit (cents, may be fractional); null when no wholesale price exists anywhere. */
function wholesaleFloorPerBase(product, variant) {
  const c = [];
  if (variant && pos(variant.wholesalePrice)) c.push(variant.wholesalePrice);
  else if (pos(product.wholesalePrice)) c.push(product.wholesalePrice);
  for (const u of product.units || []) if (u.status !== 'inactive' && pos(u.wholesalePrice) && pos(u.factor)) c.push(u.wholesalePrice / u.factor);
  return c.length ? Math.max(...c) : null;
}

/**
 * Retail price rule for stock moved warehouse -> retail: new price per base unit must be HIGHER than the wholesale
 * value of that unit (floor); without any wholesale price it must be higher than cost.
 */
function evaluateRetailPrice({ requestedCents, existingCents = 0, wholesaleFloor = null, costCents = 0 }) {
  const hasW = pos(wholesaleFloor);
  const floorCents = hasW ? wholesaleFloor : (Number(costCents) || 0);
  const floorKind = hasW ? 'WHOLESALE' : 'COST';
  const given = requestedCents !== undefined && requestedCents !== null;
  const priceCents = given ? Math.round(requestedCents) : Math.round(existingCents || 0);
  const changed = given && priceCents !== Math.round(existingCents || 0);
  let error = null;
  if (priceCents <= floorCents) {
    const kes = (floorCents / 100).toFixed(2); // amount in the business's own currency
    error = {
      code: given ? 'RETAIL_PRICE_TOO_LOW' : 'RETAIL_PRICE_REQUIRED',
      message: given
        ? `The retail price must be higher than the ${hasW ? 'wholesale price' : 'cost'} of ${kes} per unit`
        : `Set a retail selling price: the current one is not higher than the ${hasW ? 'wholesale price' : 'cost'} of ${kes} per unit`,
    };
  }
  return { priceCents, changed, floorCents, floorKind, error };
}

/**
 * Retail price (cents per BASE unit) the owner already configured on a unit (bundle retailPrice / factor).
 * Used as the default when stock is moved warehouse -> retail without a typed price. null when none is set.
 */
function suggestedRetailPerBase(product) {
  const c = [];
  for (const u of product.units || []) if (u.status !== 'inactive' && pos(u.retailPrice) && pos(u.factor)) c.push(u.retailPrice / u.factor);
  return c.length ? Math.round(Math.max(...c)) : null;
}

/** 53 packets with a bundle of 24 -> [{unit:'bundle', whole:2, remainderBase:5}, ...] (quick "how many bundles" view). */
function unitBreakdown(product, baseQty) {
  return (product?.units || []).filter((u) => u.status !== 'inactive' && u.factor > 0).map((u) => {
    const whole = Math.floor(round3(baseQty / u.factor));
    return { unitId: u._id, unit: u.name, factor: u.factor, whole, remainderBase: round3(baseQty - whole * u.factor) };
  });
}

/** Validate a product's units[] ({name,factor,...}). Returns [{path,message}]. */
function unitConfigIssues(units = [], baseUnit = 'piece') {
  const issues = [];
  const seen = new Set([String(baseUnit).toLowerCase()]);
  units.forEach((u, i) => {
    const n = String(u.name || '').trim().toLowerCase();
    if (!pos(u.factor)) issues.push({ path: ['units', i, 'factor'], message: 'Factor must be greater than 0' });
    if (seen.has(n)) issues.push({ path: ['units', i, 'name'], message: `Unit name "${u.name}" is used twice (or equals the base unit)` });
    seen.add(n);
  });
  units.forEach((u, i) => { if (pos(u.factor) && u.factor > 10000000) issues.push({ path: ['units', i, 'factor'], message: 'Factor is too large' }); });
  if (units.filter((u) => u.isWholesaleDefault).length > 1) issues.push({ path: ['units'], message: 'Only one unit can be the wholesale default' });
  return issues;
}


/* ------------------------------------------------------------------ *
 * DYNAMIC UNIT CONVERSION helpers (price breakdown, profit, break-down plans, presets)
 * All money is integer cents. Stock/quantities are BASE units. Pure functions.
 * ------------------------------------------------------------------ */

/** Cost (cents, fractional) of ONE base unit for a product / variant. */
const costPerBase = (product, variant) => Number((variant ? variant.costPrice : product.costPrice) || 0);

/**
 * Cost / price / profit of the base unit and of every active unit. This is the "price breakdown" table.
 * profit = price - cost for ONE sold unit, margin = profit / price. `belowCost` flags a loss-making unit.
 */
function unitEconomics(product, variant = null) {
  const cost = costPerBase(product, variant);
  const retailBase = Number((variant ? variant.sellingPrice : product.sellingPrice) || 0);
  const wsBase = (variant && pos(variant.wholesalePrice)) ? variant.wholesalePrice : (pos(product.wholesalePrice) ? product.wholesalePrice : null);
  const row = (o) => {
    const costCents = Math.round(cost * o.factor);
    const profitCents = o.retailCents - costCents;
    const wholesaleProfitCents = o.wholesaleCents != null ? o.wholesaleCents - costCents : null;
    return {
      ...o, costCents, profitCents,
      marginPct: o.retailCents > 0 ? Math.round((profitCents / o.retailCents) * 1000) / 10 : null,
      markupPct: costCents > 0 ? Math.round((profitCents / costCents) * 1000) / 10 : null,
      wholesaleProfitCents,
      perBaseRetailCents: o.factor > 0 ? Math.round((o.retailCents / o.factor) * 100) / 100 : null,
      belowCost: costCents > 0 && o.retailCents < costCents,
    };
  };
  const rows = [row({
    unitId: null, name: product.unit || 'piece', kind: 'base', factor: 1, isBase: true,
    retailCents: retailBase, wholesaleCents: wsBase,
  })];
  const units = (product.units || []).filter((u) => u.status !== 'inactive' && pos(u.factor))
    .slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || b.factor - a.factor);
  for (const u of units) {
    const unit = { unit: u, factor: u.factor };
    rows.push(row({
      unitId: u._id, name: u.name, kind: u.kind || 'custom', code: u.code || null, factor: u.factor, isBase: false,
      retailCents: retailUnitPrice(product, variant, unit),
      wholesaleCents: (wsBase !== null || pos(u.wholesalePrice)) ? wholesaleUnitPrice(product, variant, unit) : null,
      customRetail: pos(u.retailPrice), customWholesale: pos(u.wholesalePrice),
    }));
  }
  return { baseUnit: product.unit || 'piece', costPerBaseCents: cost, rows };
}

/** Weighted-average cost per base unit after adding stock: (old x onHand + new x qty) / (onHand + qty). */
function weightedCost({ onHand = 0, oldCost = 0, addQty = 0, addCost = 0 }) {
  const have = Math.max(Number(onHand) || 0, 0);
  const total = have + addQty;
  if (!(total > 0)) return Math.round(addCost);
  if (!(have > 0) || !(oldCost > 0)) return Math.round(addCost);
  return Math.round(((oldCost * have) + (addCost * addQty)) / total);
}

/**
 * Plan for breaking stock into sellable sizes. outputs = [{ unit (resolved), count }].
 * Returns the base quantity used, what is left loose, and what each output piece costs once packaging cost
 * and (optionally) wastage are shared over the pieces.
 */
function planBreakdown({ sourceBase, outputs = [], wastageBase = 0, extraCostCents = 0, costPerBaseCents = 0, absorbWastage = false }) {
  const src = round3(sourceBase);
  const waste = round3(wastageBase || 0);
  const lines = outputs.map((o) => ({ ...o, base: round3(o.count * o.unit.factor) }));
  const used = round3(lines.reduce((a, l) => a + l.base, 0));
  const leftover = round3(src - used - waste);
  const totalPieces = lines.reduce((a, l) => a + l.count, 0);
  const sourceValue = costPerBaseCents * src;                       // what the stock being broken cost
  const goodBase = src - waste;                                     // base units that can still be sold
  // new cost per base unit of the broken stock: wastage is either a separate loss or shared over what is left
  const newCostPerBase = goodBase > 0
    ? ((absorbWastage ? sourceValue : costPerBaseCents * goodBase) + (extraCostCents || 0)) / goodBase
    : costPerBaseCents;
  const wastageLossCents = absorbWastage ? 0 : Math.round(costPerBaseCents * waste);
  return {
    sourceBase: src, usedBase: used, wastageBase: waste, leftoverBase: leftover, totalPieces,
    newCostPerBaseCents: Math.round(newCostPerBase * 100) / 100, wastageLossCents,
    lines: lines.map((l) => ({ ...l, costEachCents: Math.round(newCostPerBase * l.unit.factor) })),
    ok: leftover >= -0.0005 && src > 0,
  };
}

/** Handy size sets for a base unit: 'kg' -> 250g, 500g, 1kg, 2kg ... Values are in the BASE unit. */
function sizePresets(baseUnit) {
  const b = String(baseUnit || '').toLowerCase();
  const mk = (arr) => arr.map(([name, factor]) => ({ name, factor, kind: 'size' }));
  if (b === 'kg') return mk([['250g', 0.25], ['500g', 0.5], ['1kg', 1], ['2kg', 2], ['5kg', 5], ['10kg', 10]]);
  if (b === 'g') return mk([['100g', 100], ['250g', 250], ['500g', 500], ['1kg', 1000], ['2kg', 2000]]);
  if (b === 'litre') return mk([['250ml', 0.25], ['500ml', 0.5], ['1 litre', 1], ['2 litre', 2], ['5 litre', 5], ['20 litre', 20]]);
  if (b === 'ml') return mk([['100ml', 100], ['250ml', 250], ['500ml', 500], ['1 litre', 1000]]);
  if (b === 'metre') return mk([['Half metre', 0.5], ['2 metre', 2], ['5 metre', 5], ['10 metre', 10]]);
  return mk([['Pair', 2], ['Half dozen', 6], ['Dozen', 12]]);
}

/** Fractions of a bulk pack: 1/4, 1/2, 3/4 of a 25kg bag -> factors 6.25, 12.5, 18.75. */
function fractionPresets(packName, packSize) {
  const n = packName || 'pack';
  return [['1/4', 0.25], ['1/2', 0.5], ['3/4', 0.75]].map(([f, k]) => ({ name: `${f} ${n}`, factor: round3(packSize * k), kind: 'fraction' }));
}

/** Round to the 3 decimals stock is kept in; used for display of per-unit price when the price is fractional cents. */
const perBasePrice = (priceCents, factor) => (factor > 0 ? Math.round((priceCents / factor) * 100) / 100 : 0);

module.exports = {
  costPerBase, unitEconomics, weightedCost, planBreakdown, sizePresets, fractionPresets, perBasePrice, round3, resolveUnit, toBase, wholesaleUnitPrice, retailUnitPrice, wholesaleFloorPerBase, evaluateRetailPrice, unitConfigIssues, suggestedRetailPerBase, unitBreakdown };
