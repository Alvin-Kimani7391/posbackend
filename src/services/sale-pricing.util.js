const { ROLES } = require('../constants/roles');

/**
 * Computes one sale line's totals. All money in/out is integer cents.
 * quantity may be fractional (weighted products, e.g. 1.5 kg).
 *
 * taxInclusive semantics:
 *  - true:  unitPrice already includes tax. taxAmount is backed out of the
 *           post-discount line total; lineTotal === netLineTotal.
 *  - false: unitPrice excludes tax. taxAmount is added on top of the
 *           post-discount line total; lineTotal === netLineTotal + taxAmount.
 */
function computeLineItem({ unitPrice, quantity, discount = 0, taxRate = 0, taxInclusive = true }) {
  const grossLineTotal = Math.round(unitPrice * quantity);
  const netLineTotal = grossLineTotal - discount;

  let taxAmount;
  let lineTotal;

  if (taxInclusive) {
    taxAmount = netLineTotal - Math.round(netLineTotal / (1 + taxRate / 100));
    lineTotal = netLineTotal;
  } else {
    taxAmount = Math.round(netLineTotal * (taxRate / 100));
    lineTotal = netLineTotal + taxAmount;
  }

  return { grossLineTotal, netLineTotal, taxAmount, lineTotal, discountApplied: discount };
}

/**
 * Sums an array of computed line items (+ an optional flat cart-level
 * discount applied after tax) into the sale's top-level totals.
 */
function computeSaleTotals(lineItems, cartDiscount = 0) {
  const subtotal = lineItems.reduce((sum, l) => sum + l.grossLineTotal, 0);
  const itemDiscount = lineItems.reduce((sum, l) => sum + (l.discountApplied || 0), 0);
  const tax = lineItems.reduce((sum, l) => sum + l.taxAmount, 0);
  const linesTotal = lineItems.reduce((sum, l) => sum + l.lineTotal, 0);
  const total = linesTotal - cartDiscount;
  return { subtotal, itemDiscount, tax, total };
}

/** Max discount % a role may apply, per the business's own configured limits. OWNER/ADMIN are unrestricted. */
function maxDiscountPercentForRole(role, business) {
  if (role === ROLES.OWNER || role === ROLES.ADMIN) return 100;
  if (role === ROLES.MANAGER) return business?.settings?.maxManagerDiscountPercent ?? 20;
  if (role === ROLES.CASHIER) return business?.settings?.maxCashierDiscountPercent ?? 5;
  return 0; // other roles (storekeeper, accountant) don't sell, so no discount authority
}

/** Whether this user may override a product's price on a sale line. */
function canOverridePrice(user, business) {
  if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN || user.role === ROLES.MANAGER) return true;
  if (user.role === ROLES.CASHIER) return !!business?.settings?.cashierPriceOverride;
  return false;
}

module.exports = { computeLineItem, computeSaleTotals, maxDiscountPercentForRole, canOverridePrice };
