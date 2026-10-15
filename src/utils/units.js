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
    const kes = (floorCents / 100).toFixed(2);
    error = {
      code: given ? 'RETAIL_PRICE_TOO_LOW' : 'RETAIL_PRICE_REQUIRED',
      message: given
        ? `The retail price must be higher than the ${hasW ? 'wholesale price' : 'cost'} of KES ${kes} per unit`
        : `Set a retail selling price: the current one is not higher than the ${hasW ? 'wholesale price' : 'cost'} of KES ${kes} per unit`,
    };
  }
  return { priceCents, changed, floorCents, floorKind, error };
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
  if (units.filter((u) => u.isWholesaleDefault).length > 1) issues.push({ path: ['units'], message: 'Only one unit can be the wholesale default' });
  return issues;
}

module.exports = { round3, resolveUnit, toBase, wholesaleUnitPrice, retailUnitPrice, wholesaleFloorPerBase, evaluateRetailPrice, unitConfigIssues };
