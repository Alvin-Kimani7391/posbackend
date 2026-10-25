const { ROLES } = require('./roles');

// Flat list of every permission the system understands.
const PERMISSIONS = Object.freeze([
  'categories.view', 'categories.create', 'categories.update', 'categories.delete',
  'products.view', 'products.create', 'products.update', 'products.delete',
  'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer',
  'warehouses.manage', // create / edit warehouses, wholesale dashboard settings
  'batches.view', 'batches.manage', // view batches/expiry; quarantine, release, dispose, recall
  'stocktake.view', 'stocktake.count', 'stocktake.manage', 'stocktake.approve', // count / start+cancel / approve variances
  'serials.view', 'serials.manage',                       // look up units; inspect returned units
  'warranty.view', 'warranty.manage', 'warranty.decide',  // view / open claims / decide (repair, replace, reject, goodwill)
  'repairs.view', 'repairs.manage', 'repairs.approve',    // view / run jobs / refunds + waivers
  'medicines.view', 'medicines.manage',                   // pharmacy: medicine master data (view / edit, classify, set status)
  'patients.view', 'patients.manage',                     // pharmacy: patient records (every read is audit-logged)
  'prescriptions.view', 'prescriptions.intake', 'prescriptions.review', // view / record a prescription / pharmacist review, interventions
  'pharmacy.dispense', 'pharmacy.restricted',             // sell Rx / dispenser-only medicines / restricted-controlled medicines
  'pharmacy.reverse', 'pharmacy.recall', 'pharmacy.storage', // reverse a dispensing / run recalls / log + assess storage exceptions
  'pharmacy.reports', 'pharmacy.settings',                // compliance reports + dashboard / classes, rules, staff credentials
  'layaways.view', 'layaways.manage', 'layaways.approve',   // view / take layaways + instalments + hand over / cancel with refund, extend
  'tradeins.view', 'tradeins.manage', 'tradeins.approve',   // view / appraise + accept / approve large offers
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
    'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer', 'warehouses.manage',
    'batches.view', 'batches.manage',
    'stocktake.view', 'stocktake.count', 'stocktake.manage', 'stocktake.approve',
    'serials.view', 'serials.manage', 'warranty.view', 'warranty.manage', 'warranty.decide', 'repairs.view', 'repairs.manage', 'repairs.approve',
    'vehicles.view', 'vehicles.manage', 'jobcards.view', 'jobcards.manage', 'jobcards.work', 'jobcards.approve',
    'layaways.view', 'layaways.manage', 'layaways.approve', 'tradeins.view', 'tradeins.manage', 'tradeins.approve',
    'medicines.view', 'medicines.manage', 'pharmacy.recall', 'pharmacy.storage', 'pharmacy.reports', // clinical + patient permissions are granted per person, never by role
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
    'medicines.view',
    'products.view',
    'inventory.view',
    'batches.view',
    'serials.view', 'warranty.view', 'warranty.manage', 'repairs.view', 'repairs.manage',
    'vehicles.view', 'vehicles.manage', 'jobcards.view', 'jobcards.manage',
    'layaways.view', 'layaways.manage', 'tradeins.view', 'tradeins.manage',
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
  [ROLES.PHARMACIST]: [
    'categories.view', 'products.view', 'inventory.view', 'inventory.receive', 'batches.view', 'batches.manage',
    'medicines.view', 'medicines.manage', 'patients.view', 'patients.manage',
    'prescriptions.view', 'prescriptions.intake', 'prescriptions.review',
    'pharmacy.dispense', 'pharmacy.restricted', 'pharmacy.reverse', 'pharmacy.recall', 'pharmacy.storage', 'pharmacy.reports', 'pharmacy.settings',
    'sales.create', 'sales.view', 'refunds.view', 'refunds.create', 'payments.view',
    'customers.view', 'customers.create',
    'suppliers.view', 'purchases.view', 'purchases.create', 'purchases.receive',
    'registers.view', 'shifts.open', 'shifts.close', 'shifts.view',
    'notifications.view', 'tickets.view', 'tickets.create',
  ],
  [ROLES.STOREKEEPER]: [
    'medicines.view', 'pharmacy.storage',
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
    'stocktake.view', 'warranty.view', 'repairs.view', 'vehicles.view', 'jobcards.view', 'layaways.view', 'tradeins.view',
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

// Restaurant permissions + defaults for every role are merged in from their own file.
module.exports = require('./tvPermissions').extend(require('./restaurantPermissions').extend({ PERMISSIONS, DEFAULT_ROLE_PERMISSIONS }));