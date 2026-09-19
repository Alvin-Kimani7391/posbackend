/**
 * money.js
 *
 * STRATEGY (applied everywhere in this codebase, per project convention):
 * - API requests/responses use decimal KES (major units), e.g. 1250.50
 * - Internally, every stored monetary field is an INTEGER number of cents
 *   (minor units), e.g. 125050. This avoids floating-point drift across
 *   repeated addition/subtraction (discounts, tax, split payments, etc.)
 * - Validators convert incoming decimal amounts to cents with toCents()
 *   before they reach a service. Controllers/services convert back to
 *   decimal with fromCents() only when building the API response.
 * - Never do money arithmetic in decimal/float. Always operate on the
 *   integer cent values, then convert once at the boundary.
 */

/** Decimal KES -> integer cents. Rounds to the nearest cent. */
function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Integer cents -> decimal KES (2dp number, not a string). */
function fromCents(cents) {
  const n = Number(cents) || 0;
  return Math.round(n) / 100;
}

/** Percentage (e.g. 16 for 16%) applied to a cents amount, rounded to nearest cent. */
function percentOfCents(cents, percent) {
  return Math.round((Number(cents) || 0) * (Number(percent) || 0) / 100);
}

/** Recursively converts plain-object monetary fields for API output. Use per-DTO instead where possible. */
function sumCents(...values) {
  return values.reduce((acc, v) => acc + (Number(v) || 0), 0);
}

module.exports = { toCents, fromCents, percentOfCents, sumCents };
