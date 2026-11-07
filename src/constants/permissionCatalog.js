/**
 * permissionCatalog.js
 * Human-friendly view of the permission list for the "Access control" screen.
 * Built FROM the real PERMISSIONS list, so a permission added anywhere in the backend shows up automatically.
 */
const { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } = require('./permissions');
const { ROLES } = require('./roles');

const GROUP_LABELS = {
  categories: 'Categories', products: 'Products', inventory: 'Inventory & stock', warehouses: 'Warehouses', batches: 'Batches & expiry',
  stocktake: 'Stock takes', serials: 'Serial numbers', warranty: 'Warranty', repairs: 'Repairs', medicines: 'Medicines', patients: 'Patients',
  prescriptions: 'Prescriptions', pharmacy: 'Pharmacy', layaways: 'Layaways', tradeins: 'Trade-ins', vehicles: 'Vehicles', jobcards: 'Job cards',
  sales: 'Sales', refunds: 'Refunds', expenses: 'Expenses', employees: 'Employees & access', reports: 'Reports', settings: 'Settings',
  payments: 'Payments', etims: 'eTIMS', audit: 'Audit log', branches: 'Branches', customers: 'Customers', suppliers: 'Suppliers',
  purchases: 'Purchases', registers: 'Cash registers', shifts: 'Shifts', shortages: 'Cashier shortages', devices: 'Devices', offline: 'Offline sales',
  notifications: 'Notifications', billing: 'Billing', tickets: 'Support tickets', cashier: 'Cashier desk', restaurant: 'Restaurant',
  accommodation: 'Accommodation', tv: 'Live TV', shop: 'Shop tools', liquor: 'Wines & spirits', hardware: 'Hardware & building materials',
};
// Groups that only matter when a business module is on (the UI folds the rest away by default).
const GROUP_FEATURE = {
  restaurant: 'restaurantOrdering', cashier: 'restaurantOrdering', accommodation: 'accommodation',
  medicines: 'pharmacyDispensing', patients: 'pharmacyDispensing', prescriptions: 'pharmacyDispensing', pharmacy: 'pharmacyDispensing',
};
// Risky if given carelessly: money out, price/stock tampering, personal data, staff & settings control.
const SENSITIVE = new Set([
  'sales.cancel', 'sales.price_override', 'refunds.approve', 'payments.refund', 'expenses.approve', 'inventory.adjust', 'stocktake.approve',
  'reports.profit', 'settings.update', 'employees.create', 'employees.update', 'employees.delete', 'employees.permissions', 'branches.delete',
  'billing.pay', 'purchases.pay', 'purchases.return', 'audit.view', 'devices.revoke', 'offline.review', 'patients.view', 'patients.manage', 'pharmacy.restricted',
  'pharmacy.reverse', 'pharmacy.settings', 'warranty.decide', 'jobcards.approve', 'repairs.approve', 'layaways.approve', 'tradeins.approve',
]);
const DESCRIPTIONS = {
  'sales.price_override': 'Change the selling price at the till',
  'sales.cancel': 'Cancel a completed sale',
  'refunds.approve': 'Approve refunds that need sign-off',
  'reports.profit': 'See profit and cost figures',
  'inventory.adjust': 'Change stock quantities directly',
  'employees.permissions': 'Change what other staff are allowed to do',
  'settings.update': 'Change business settings',
  'audit.view': 'Read the audit trail',
  'billing.pay': 'Pay the subscription / add-ons',
  'billing.view': 'See subscription amounts',
  'purchases.return': 'Send received purchases back to the supplier and reduce what you owe',
};

const humanize = (s) => { const t = s.replace(/[_.]/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

function describe(key) {
  const parts = key.split('.');
  const group = parts[0];
  const section = parts.length > 2 ? parts[1] : null;
  const action = parts.slice(section ? 2 : 1).join(' ');
  return {
    key, group, section: section ? humanize(section) : null, label: humanize(action || group),
    description: DESCRIPTIONS[key] || null, sensitive: SENSITIVE.has(key),
  };
}

function buildCatalog() {
  const items = PERMISSIONS.map(describe);
  const groupKeys = [...new Set(items.map((i) => i.group))];
  const groups = groupKeys.map((k) => ({ key: k, label: GROUP_LABELS[k] || humanize(k), feature: GROUP_FEATURE[k] || null, count: items.filter((i) => i.group === k).length }));
  const roles = Object.values(ROLES).filter((r) => r !== ROLES.SUPER_ADMIN && r !== ROLES.OWNER)
    .map((r) => ({ role: r, label: humanize(r.toLowerCase()), defaults: DEFAULT_ROLE_PERMISSIONS[r] || [] }));
  return { groups, permissions: items, roles };
}

let cached; // the catalog is static for the life of the process
module.exports = { getCatalog: () => cached || (cached = buildCatalog()), SENSITIVE, describe };