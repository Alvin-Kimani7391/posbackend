/**
 * permissionImplications.js
 * "To do X you must also be able to see/use Y." Giving someone X automatically gives them the prerequisites,
 * so a custom permission never ends up half-working (e.g. "receive stock" but the Inventory page is hidden).
 * An explicit DENY on a prerequisite is still respected.
 */
const { PERMISSIONS } = require('./permissions');

const RAW = {
  'inventory.view': ['products.view', 'categories.view'],
  'inventory.adjust': ['inventory.view', 'products.view'],
  'inventory.receive': ['inventory.view', 'products.view'],
  'inventory.transfer': ['inventory.view', 'products.view'],
  'products.create': ['products.view', 'categories.view'],
  'products.update': ['products.view', 'categories.view'],
  'products.delete': ['products.view'],
  'categories.create': ['categories.view'], 'categories.update': ['categories.view'], 'categories.delete': ['categories.view'],
  'purchases.create': ['purchases.view', 'suppliers.view', 'products.view', 'inventory.view'],
  'purchases.receive': ['purchases.view', 'suppliers.view', 'products.view', 'inventory.view'],
  'purchases.pay': ['purchases.view', 'suppliers.view'],
  'purchases.return': ['purchases.view', 'suppliers.view', 'inventory.view'],
  'purchases.view': ['suppliers.view', 'products.view'],
  'suppliers.create': ['suppliers.view'], 'suppliers.update': ['suppliers.view'],
  'sales.create': ['sales.view', 'products.view', 'inventory.view', 'customers.view'],
  'sales.cancel': ['sales.view'],
  'sales.price_override': ['sales.view', 'sales.create', 'products.view'],
  'refunds.create': ['refunds.view', 'sales.view'], 'refunds.approve': ['refunds.view', 'sales.view'],
  'expenses.create': ['expenses.view'], 'expenses.approve': ['expenses.view'],
  'stocktake.count': ['stocktake.view', 'inventory.view', 'products.view'],
  'stocktake.manage': ['stocktake.view', 'inventory.view', 'products.view'],
  'stocktake.approve': ['stocktake.view', 'inventory.view', 'products.view'],
  'batches.manage': ['batches.view', 'inventory.view'],
  'customers.create': ['customers.view'], 'customers.update': ['customers.view'],
  'reports.profit': ['reports.view'],
  'shifts.open': ['shifts.view', 'registers.view'], 'shifts.close': ['shifts.view', 'registers.view'],
  'registers.manage': ['registers.view'],
  'shortages.manage': ['shortages.view'],
  'employees.create': ['employees.view'], 'employees.update': ['employees.view'], 'employees.delete': ['employees.view'],
  'branches.create': ['branches.view'], 'branches.update': ['branches.view'], 'branches.delete': ['branches.view'],
  'serials.manage': ['serials.view'],
};

const KNOWN = new Set(PERMISSIONS);
const IMPLIES = {};
for (const [k, v] of Object.entries(RAW)) if (KNOWN.has(k)) IMPLIES[k] = v.filter((x) => KNOWN.has(x));

module.exports = { IMPLIES };
