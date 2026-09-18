const { ROLES } = require('./roles');

// Flat list of every permission the system understands.
const PERMISSIONS = Object.freeze([
  'products.view', 'products.create', 'products.update', 'products.delete',
  'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer',
  'sales.create', 'sales.view', 'sales.cancel',
  'refunds.create', 'refunds.approve',
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
  'purchases.view', 'purchases.create',
  'shifts.open', 'shifts.close', 'shifts.view',
  'devices.view', 'devices.revoke',
]);

// Default permission sets granted to each role. OWNER always gets everything
// (enforced in the permission middleware, not just here) regardless of this list.
const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  [ROLES.OWNER]: [...PERMISSIONS],
  [ROLES.ADMIN]: [...PERMISSIONS].filter((p) => p !== 'settings.update'),
  [ROLES.MANAGER]: [
    'products.view', 'products.create', 'products.update',
    'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer',
    'sales.create', 'sales.view', 'sales.cancel',
    'refunds.create', 'refunds.approve',
    'expenses.create', 'expenses.view', 'expenses.approve',
    'employees.view',
    'reports.view', 'reports.profit',
    'payments.view', 'payments.refund',
    'customers.view', 'customers.create', 'customers.update',
    'suppliers.view', 'suppliers.create', 'suppliers.update',
    'purchases.view', 'purchases.create',
    'shifts.open', 'shifts.close', 'shifts.view',
  ],
  [ROLES.CASHIER]: [
    'products.view',
    'sales.create', 'sales.view',
    'refunds.create',
    'payments.view',
    'customers.view', 'customers.create',
    'shifts.open', 'shifts.close', 'shifts.view',
  ],
  [ROLES.STOREKEEPER]: [
    'products.view', 'products.create', 'products.update',
    'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer',
    'suppliers.view', 'suppliers.create',
    'purchases.view', 'purchases.create',
  ],
  [ROLES.ACCOUNTANT]: [
    'reports.view', 'reports.profit',
    'expenses.view', 'expenses.approve',
    'payments.view',
    'customers.view',
    'suppliers.view',
    'audit.view',
    'etims.view',
  ],
});

module.exports = { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS };
