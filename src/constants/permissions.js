const { ROLES } = require('./roles');

// Flat list of every permission the system understands.
const PERMISSIONS = Object.freeze([
  'categories.view', 'categories.create', 'categories.update', 'categories.delete',
  'products.view', 'products.create', 'products.update', 'products.delete',
  'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer',
  'batches.view', 'batches.manage', // view batches/expiry; quarantine, release, dispose, recall
  'stocktake.view', 'stocktake.count', 'stocktake.manage', 'stocktake.approve', // count / start+cancel / approve variances
  'serials.view', 'serials.manage',                       // look up units; inspect returned units
  'warranty.view', 'warranty.manage', 'warranty.decide',  // view / open claims / decide (repair, replace, reject, goodwill)
  'repairs.view', 'repairs.manage', 'repairs.approve',    // view / run jobs / refunds + waivers
  'vehicles.view', 'vehicles.manage',                     // garage: vehicle register
  'jobcards.view', 'jobcards.manage', 'jobcards.work', 'jobcards.approve', // view / run cards + payments / mechanic work + QC / refunds, waivers, free comebacks
  'sales.create', 'sales.view', 'sales.cancel', 'sales.price_override',
  'refunds.view', 'refunds.create', 'refunds.approve',
  'expenses.create', 'expenses.view', 'expenses.approve',
  'employees.view', 'employees.create', 'employees.update', 'employees.delete',
  'reports.view', 'reports.profit',
  'settings.view', 'settings.update',
  'payments.view', 'payments.refund',
  'etims.view', 'etims.submit',
  'audit.view',
  'branches.view', 'branches.create', 'branches.update', 'branches.delete',
  'customers.view', 'customers.create', 'customers.update',
  'suppliers.view', 'suppliers.create', 'suppliers.update',
  'purchases.view', 'purchases.create', 'purchases.receive', 'purchases.pay',
  'registers.view', 'registers.manage',
  'shifts.open', 'shifts.close', 'shifts.view',
  'shortages.view', 'shortages.manage', // view (own only unless manage) / record repayments & clear
  'devices.view', 'devices.revoke',
  'notifications.view', 'notifications.send',
  'billing.view', 'billing.pay',

  'devices.manage', 'offline.review',
]);

// Default permission sets granted to each role. OWNER always gets everything
// (enforced in the permission middleware, not just here) regardless of this list.
const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  [ROLES.OWNER]: [...PERMISSIONS],
  [ROLES.ADMIN]: [...PERMISSIONS].filter((p) => p !== 'settings.update'),
  [ROLES.MANAGER]: [
    'categories.view', 'categories.create', 'categories.update',
    'products.view', 'products.create', 'products.update',
    'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer',
    'batches.view', 'batches.manage',
    'stocktake.view', 'stocktake.count', 'stocktake.manage', 'stocktake.approve',
    'serials.view', 'serials.manage', 'warranty.view', 'warranty.manage', 'warranty.decide', 'repairs.view', 'repairs.manage', 'repairs.approve',
    'vehicles.view', 'vehicles.manage', 'jobcards.view', 'jobcards.manage', 'jobcards.work', 'jobcards.approve',
    'sales.create', 'sales.view', 'sales.cancel', 'sales.price_override',
    'refunds.view', 'refunds.create', 'refunds.approve',
    'expenses.create', 'expenses.view', 'expenses.approve',
    'employees.view',
    'reports.view', 'reports.profit',
    'payments.view', 'payments.refund',
    'customers.view', 'customers.create', 'customers.update',
    'suppliers.view', 'suppliers.create', 'suppliers.update',
    'purchases.view', 'purchases.create', 'purchases.receive', 'purchases.pay',
    'registers.view', 'registers.manage',
    'shifts.open', 'shifts.close', 'shifts.view',
    'shortages.view', 'shortages.manage',
    'branches.view',
    'audit.view',
    'notifications.view', 'notifications.send',
    'tickets.view', 'tickets.create',
    'billing.view', 'billing.pay',
    'devices.manage',
    'offline.review',
  ],
  [ROLES.CASHIER]: [
    'categories.view',
    'products.view',
    'inventory.view',
    'batches.view',
    'serials.view', 'warranty.view', 'warranty.manage', 'repairs.view', 'repairs.manage',
    'vehicles.view', 'vehicles.manage', 'jobcards.view', 'jobcards.manage',
    'sales.create', 'sales.view',
    'refunds.view', 'refunds.create',
    'payments.view',
    'customers.view', 'customers.create',
    'registers.view',
    'shifts.open', 'shifts.close', 'shifts.view',
    'shortages.view', // own records only (controller self-scopes)
    'notifications.view', 'notifications.send',
    'tickets.view', 'tickets.create',
  ],
  [ROLES.STOREKEEPER]: [
    'categories.view', 'categories.create', 'categories.update',
    'products.view', 'products.create', 'products.update',
    'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer',
    'batches.view', 'stocktake.view', 'stocktake.count',
    'serials.view', 'serials.manage',
    'suppliers.view', 'suppliers.create',
    'purchases.view', 'purchases.create', 'purchases.receive',
    'tickets.view', 'tickets.create',
  ],
  [ROLES.ACCOUNTANT]: [
    'categories.view', 'products.view',
    'stocktake.view', 'warranty.view', 'repairs.view', 'vehicles.view', 'jobcards.view',
    'reports.view', 'reports.profit',
    'expenses.view', 'expenses.approve',
    'payments.view',
    'purchases.view', 'purchases.pay',
    'customers.view',
    'suppliers.view',
    'audit.view',
    'etims.view',
    'shortages.view', // read-only; cannot clear
    'notifications.view',
    'tickets.view', 'tickets.create',
  ],
});

module.exports = { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS };