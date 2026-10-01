/**
 * denominations.js
 * Kenyan notes/coins a cashier counts when closing a shift.
 * Denominations are whole KES values (1000 = KES 1,000). Totals are returned in CENTS
 * to match the rest of the money conventions (see utils/money.js).
 */
const { toCents } = require('./money');

const DENOMINATIONS = [1000, 500, 200, 100, 50, 40, 20, 10, 5, 1];

/** Always returns ALL denominations (highest first), filling missing ones with count 0. */
function normalizeDenominations(lines = []) {
  const counts = new Map();
  (lines || []).forEach((l) => {
    const d = Number(l.denomination);
    const c = Math.max(Math.floor(Number(l.count) || 0), 0);
    if (DENOMINATIONS.includes(d)) counts.set(d, (counts.get(d) || 0) + c);
  });
  return DENOMINATIONS.map((d) => ({ denomination: d, count: counts.get(d) || 0 }));
}

/** Total of a denominations array, in integer cents. */
function denominationsTotalCents(lines = []) {
  return lines.reduce((sum, l) => sum + toCents(l.denomination * l.count), 0);
}

module.exports = { DENOMINATIONS, normalizeDenominations, denominationsTotalCents };