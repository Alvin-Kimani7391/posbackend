/** General-shop permissions. permissions.js chains extend() after the restaurant one. */
const { ROLES } = require('./roles');

const SHOP_PERMISSIONS = Object.freeze([
  'shop.import',            // import / export products by spreadsheet
  'shop.prices.manage',     // bulk price changes + revert
  'shop.barcodes.manage',   // generate internal barcodes, print labels
  'shop.held.use',          // park and recall your own held sales
  'shop.held.manage',       // see and discard anyone's held sales
  'shop.promotions.view',   // see active offers (cashiers)
  'shop.promotions.manage', // create / edit offers
  'shop.reports.view',      // end-of-day, margins, dead stock, valuation, reorder list, credit aging
  'shop.onboarding.manage', // guided set-up checklist and starter data
]);

const ROLE_GRANTS = {
  [ROLES.MANAGER]: [...SHOP_PERMISSIONS],
  [ROLES.CASHIER]: ['shop.held.use', 'shop.promotions.view'],
  [ROLES.STOREKEEPER]: ['shop.import', 'shop.barcodes.manage'],
  [ROLES.ACCOUNTANT]: ['shop.reports.view'],
};

function extend({ PERMISSIONS, DEFAULT_ROLE_PERMISSIONS }) {
  const all = Object.freeze([...new Set([...PERMISSIONS, ...SHOP_PERMISSIONS])]);
  const roles = { ...DEFAULT_ROLE_PERMISSIONS };
  for (const [role, grants] of Object.entries(ROLE_GRANTS)) roles[role] = [...new Set([...(roles[role] || []), ...grants])];
  roles[ROLES.OWNER] = [...all];
  roles[ROLES.ADMIN] = [...new Set([...(DEFAULT_ROLE_PERMISSIONS[ROLES.ADMIN] || []), ...SHOP_PERMISSIONS])];
  return { PERMISSIONS: all, DEFAULT_ROLE_PERMISSIONS: Object.freeze(roles) };
}
module.exports = { SHOP_PERMISSIONS, ROLE_GRANTS, extend };
