/**
 * denominations.js
 * The notes/coins a cashier counts when closing a shift. The set depends on the business's CURRENCY:
 *   KES: 1000, 500, 200, 100, 50, 40, 20, 10, 5, 1
 *   TZS: 10000, 5000, 2000, 1000, 500, 200, 100, 50
 * Denominations are whole major-unit values (1000 = 1,000 shillings). Totals are returned in CENTS to
 * match the rest of the money conventions (see utils/money.js).
 *
 * Every function takes the currency and defaults to KES, so legacy Kenyan callers/shifts behave exactly
 * as before. A closed shift stores the denominations it was counted with, so history never changes.
 */
const { toCents } = require('./money');
const { COUNTRIES } = require('../constants/countries');

const BY_CURRENCY = Object.freeze(
  Object.fromEntries(Object.values(COUNTRIES).map((c) => [c.currency, c.denominations]))
);

const DEFAULT_CURRENCY = 'KES';
const DENOMINATIONS = BY_CURRENCY[DEFAULT_CURRENCY]; // kept for backwards compatibility (Kenya)

/** Denominations for a currency, highest first. Unknown currency falls back to KES. */
function getDenominations(currency = DEFAULT_CURRENCY) {
  return BY_CURRENCY[currency] || BY_CURRENCY[DEFAULT_CURRENCY];
}

/** Returns the denominations in `lines` that this currency does not have (e.g. a 40 sent for TZS). */
function unsupportedDenominations(lines = [], currency = DEFAULT_CURRENCY) {
  const allowed = getDenominations(currency);
  return [...new Set((lines || []).map((l) => Number(l.denomination)).filter((d) => !allowed.includes(d)))];
}

/** Always returns ALL denominations of the currency (highest first), filling missing ones with count 0. */
function normalizeDenominations(lines = [], currency = DEFAULT_CURRENCY) {
  const allowed = getDenominations(currency);
  const counts = new Map();
  (lines || []).forEach((l) => {
    const d = Number(l.denomination);
    const c = Math.max(Math.floor(Number(l.count) || 0), 0);
    if (allowed.includes(d)) counts.set(d, (counts.get(d) || 0) + c);
  });
  return allowed.map((d) => ({ denomination: d, count: counts.get(d) || 0 }));
}

/** Total of a denominations array, in integer cents. */
function denominationsTotalCents(lines = []) {
  return lines.reduce((sum, l) => sum + toCents(l.denomination * l.count), 0);
}

module.exports = { DENOMINATIONS, getDenominations, unsupportedDenominations, normalizeDenominations, denominationsTotalCents };
