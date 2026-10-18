/** Ingredient units. Each ingredient has ONE base unit (g, ml, piece); all stored quantities are in it. */
const UNITS = Object.freeze({
  g: { dim: 'mass', f: 1 }, kg: { dim: 'mass', f: 1000 },
  ml: { dim: 'volume', f: 1 }, litre: { dim: 'volume', f: 1000 }, tsp: { dim: 'volume', f: 5 }, tbsp: { dim: 'volume', f: 15 }, cup: { dim: 'volume', f: 240 },
  piece: { dim: 'count', f: 1 }, dozen: { dim: 'count', f: 12 },
});
const BASE_UNIT = Object.freeze({ mass: 'g', volume: 'ml', count: 'piece' });
const UNIT_NAMES = Object.keys(UNITS);
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const isUnit = (u) => Object.prototype.hasOwnProperty.call(UNITS, u);
const dimensionOf = (u) => UNITS[u]?.dim;
const baseUnitFor = (u) => BASE_UNIT[dimensionOf(u)];
function toBase(quantity, unit) { if (!isUnit(unit)) throw new Error(`Unknown unit "${unit}"`); return round4(Number(quantity) * UNITS[unit].f); }
function convert(quantity, from, to) {
  if (!isUnit(from) || !isUnit(to)) throw new Error('Unknown unit');
  if (UNITS[from].dim !== UNITS[to].dim) throw new Error(`Cannot convert ${from} to ${to}`);
  return round4((Number(quantity) * UNITS[from].f) / UNITS[to].f);
}
const compatible = (a, b) => isUnit(a) && isUnit(b) && UNITS[a].dim === UNITS[b].dim;
module.exports = { UNITS, BASE_UNIT, UNIT_NAMES, isUnit, dimensionOf, baseUnitFor, toBase, convert, compatible, round4 };
