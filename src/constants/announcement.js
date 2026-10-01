const { ROLES } = require('./roles');

const ANNOUNCEMENT_TYPES = ['INFO', 'SUCCESS', 'WARNING', 'CRITICAL'];
const ANNOUNCEMENT_DISPLAYS = ['MODAL', 'TICKER'];
const ANNOUNCEMENT_FREQUENCIES = ['ONCE', 'EVERY_VISIT'];
const ANNOUNCEMENT_STATUSES = ['LIVE', 'SCHEDULED', 'EXPIRED', 'PAUSED'];

// Must match <body data-page="..."> on each tenant page (see NAV_ITEMS keys in app-shell.js).
const ANNOUNCEMENT_PAGES = [
  'dashboard', 'sales', 'products', 'inventory', 'suppliers', 'purchases', 'expenses',
  'refunds', 'reports', 'cash', 'branches', 'employees', 'customers', 'tickets',
  'notifications', 'settings', 'audit',
];

// SUPER_ADMIN never sees tenant pages, so it is not a valid audience.
const TARGETABLE_ROLES = Object.values(ROLES).filter((r) => r !== ROLES.SUPER_ADMIN);

module.exports = {
  ANNOUNCEMENT_TYPES,
  ANNOUNCEMENT_DISPLAYS,
  ANNOUNCEMENT_FREQUENCIES,
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_PAGES,
  TARGETABLE_ROLES,
};