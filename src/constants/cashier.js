/**
 * Cashier dashboard constants.
 *
 * WHO MAY USE IT: only the roles below. This is a ROLE gate on top of the normal permission checks
 * (middleware/requireCashierRole.js), because OWNER/ADMIN receive every permission automatically and a per-user
 * "granted permission" must not be enough to open the till dashboard. ADMIN is deliberately NOT listed.
 * To let another role in, add it here and nowhere else.
 */
const { ROLES } = require('./roles');

const CASHIER_DASHBOARD_ROLES = Object.freeze([ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER]);
/** Roles that may see every open drawer / shift of the branch (a plain cashier only sees their own). */
const CASHIER_LEAD_ROLES = Object.freeze([ROLES.OWNER, ROLES.MANAGER]);

// How an order reaches the cashier. One row in the queue always has exactly one channel.
const CHANNELS = Object.freeze({
  DINE_IN: 'Waiter served',
  SELF_SERVICE: 'Self service',
  DELIVERY: 'Delivery',
  TAKEAWAY: 'Take away / pickup',
  COUNTER: 'Counter / bar tab',
  ROOM_SERVICE: 'Room service',
  ACCOMMODATION: 'Accommodation',
});

/** Payment methods that put real money in the till or bank. ROOM / CREDIT / DEPOSIT move no money today and are reported apart. */
const MONEY_METHODS = Object.freeze(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']);

// Drawer events. CASH_SALE is written by the till screen when the drawer pops to give change; it never changes the cash total.
const DRAWER_EVENT_TYPES = Object.freeze(['NO_SALE', 'PAID_IN', 'PAID_OUT', 'SAFE_DROP', 'CASH_SALE']);
const DRAWER_MONEY_TYPES = Object.freeze(['PAID_IN', 'PAID_OUT', 'SAFE_DROP']);

module.exports = { CASHIER_DASHBOARD_ROLES, CASHIER_LEAD_ROLES, CHANNELS, MONEY_METHODS, DRAWER_EVENT_TYPES, DRAWER_MONEY_TYPES };
