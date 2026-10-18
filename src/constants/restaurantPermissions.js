/**
 * Restaurant permissions + default grants for every role. permissions.js calls extend() on its own exports, so
 * nothing in that file has to be re-listed. OWNER and ADMIN receive everything (ADMIN keeps the existing
 * "no settings.update" rule), MANAGER receives everything except the money configuration.
 */
const { ROLES } = require('./roles');

const RESTAURANT_PERMISSIONS = Object.freeze([
  'restaurant.settings.view', 'restaurant.settings.manage',
  'restaurant.menu.view', 'restaurant.menu.manage', 'restaurant.menu.soldout',
  'restaurant.tables.view', 'restaurant.tables.view_all', 'restaurant.tables.manage', 'restaurant.tables.assign',
  'restaurant.orders.view', 'restaurant.orders.view_all', 'restaurant.orders.create', 'restaurant.orders.manage',
  'restaurant.orders.void', 'restaurant.orders.comp', 'restaurant.orders.discount', 'restaurant.orders.substitute',
  'restaurant.bills.view', 'restaurant.bills.generate', 'restaurant.bills.pay', 'restaurant.bills.split',
  'restaurant.bills.credit', 'restaurant.bills.close_unpaid', 'restaurant.bills.reopen', 'restaurant.bills.refund', 'restaurant.bills.waive_service_charge',
  'restaurant.kitchen.view', 'restaurant.kitchen.update', 'restaurant.kitchen.manage', 'restaurant.kitchen.expedite',
  'restaurant.recipes.view', 'restaurant.recipes.manage',
  'restaurant.ingredients.view', 'restaurant.ingredients.manage', 'restaurant.ingredients.receive',
  'restaurant.ingredients.waste', 'restaurant.ingredients.adjust', 'restaurant.ingredients.count', 'restaurant.ingredients.approve',
  'restaurant.reservations.view', 'restaurant.reservations.manage',
  'restaurant.shifts.self', 'restaurant.shifts.view', 'restaurant.shifts.manage',
  'restaurant.tips.view', 'restaurant.tips.manage',
  'restaurant.delivery.self', 'restaurant.delivery.view', 'restaurant.delivery.manage',
  'restaurant.incidents.create', 'restaurant.incidents.manage',
  'restaurant.reports.view', 'restaurant.reports.staff', // cost / profit figures additionally need reports.profit
  // guest QR ordering: see and answer guest orders and calls; manage QR codes
  'restaurant.guest.view', 'restaurant.guest.respond', 'restaurant.guest.qr',
  // accommodation
  'accommodation.settings.view', 'accommodation.settings.manage',
  'accommodation.rooms.view', 'accommodation.rooms.manage', 'accommodation.rooms.status',
  'accommodation.stays.view', 'accommodation.stays.create', 'accommodation.stays.checkin', 'accommodation.stays.checkout',
  'accommodation.stays.manage', 'accommodation.stays.override_rate', 'accommodation.stays.waive_fees',
  'accommodation.folio.charge', 'accommodation.folio.adjust', 'accommodation.folio.pay', 'accommodation.folio.credit',
  'accommodation.folio.close_unpaid', 'accommodation.folio.refund',
  'accommodation.housekeeping.view', 'accommodation.housekeeping.update', 'accommodation.housekeeping.manage',
  'accommodation.reports.view',
]);

const MANAGER_SET = RESTAURANT_PERMISSIONS.filter((p) => !['restaurant.settings.manage', 'accommodation.settings.manage'].includes(p));

const ROLE_GRANTS = {
  [ROLES.MANAGER]: MANAGER_SET,
  [ROLES.CASHIER]: [
    'restaurant.menu.view', 'restaurant.tables.view', 'restaurant.tables.view_all', 'restaurant.orders.view', 'restaurant.orders.view_all',
    'restaurant.bills.view', 'restaurant.bills.generate', 'restaurant.bills.pay', 'restaurant.bills.split',
    'restaurant.reservations.view', 'restaurant.tips.view', 'restaurant.delivery.view',
    'restaurant.guest.view', 'restaurant.guest.respond',
    'accommodation.rooms.view', 'accommodation.stays.view', 'accommodation.folio.pay',
  ],
  [ROLES.STOREKEEPER]: [
    'restaurant.menu.view', 'restaurant.recipes.view', 'restaurant.ingredients.view', 'restaurant.ingredients.manage',
    'restaurant.ingredients.receive', 'restaurant.ingredients.waste', 'restaurant.ingredients.adjust', 'restaurant.ingredients.count',
  ],
  [ROLES.ACCOUNTANT]: [
    'restaurant.menu.view', 'restaurant.bills.view', 'restaurant.tips.view', 'restaurant.recipes.view', 'restaurant.ingredients.view',
    'restaurant.reports.view', 'restaurant.orders.view_all',
  ],
  [ROLES.WAITER]: [
    'restaurant.menu.view', 'restaurant.tables.view', 'restaurant.orders.view', 'restaurant.orders.create', 'restaurant.bills.view',
    'restaurant.reservations.view', 'restaurant.incidents.create', 'restaurant.shifts.self', 'restaurant.tips.view',
    'restaurant.guest.view', 'restaurant.guest.respond', 'accommodation.rooms.view',
    'customers.view', 'notifications.view', 'tickets.view', 'tickets.create',
  ],
  [ROLES.HEAD_WAITER]: [
    'restaurant.menu.view', 'restaurant.menu.soldout', 'restaurant.tables.view', 'restaurant.tables.view_all', 'restaurant.tables.assign',
    'restaurant.orders.view', 'restaurant.orders.view_all', 'restaurant.orders.create', 'restaurant.orders.manage', 'restaurant.orders.discount',
    'restaurant.bills.view', 'restaurant.bills.generate', 'restaurant.bills.split', 'restaurant.kitchen.view',
    'restaurant.reservations.view', 'restaurant.reservations.manage', 'restaurant.incidents.create', 'restaurant.incidents.manage',
    'restaurant.shifts.self', 'restaurant.shifts.view', 'restaurant.tips.view', 'restaurant.delivery.view',
    'restaurant.guest.view', 'restaurant.guest.respond', 'restaurant.guest.qr', 'accommodation.rooms.view',
    'customers.view', 'customers.create', 'notifications.view', 'tickets.view', 'tickets.create',
  ],
  [ROLES.SUPERVISOR]: [
    'restaurant.menu.view', 'restaurant.menu.soldout', 'restaurant.tables.view', 'restaurant.tables.view_all', 'restaurant.tables.assign', 'restaurant.tables.manage',
    'restaurant.orders.view', 'restaurant.orders.view_all', 'restaurant.orders.create', 'restaurant.orders.manage',
    'restaurant.orders.void', 'restaurant.orders.comp', 'restaurant.orders.discount', 'restaurant.orders.substitute',
    'restaurant.bills.view', 'restaurant.bills.generate', 'restaurant.bills.split', 'restaurant.bills.pay',
    'restaurant.kitchen.view', 'restaurant.kitchen.expedite', 'restaurant.reservations.view', 'restaurant.reservations.manage',
    'restaurant.incidents.create', 'restaurant.incidents.manage', 'restaurant.shifts.self', 'restaurant.shifts.view', 'restaurant.shifts.manage',
    'restaurant.tips.view', 'restaurant.delivery.view', 'restaurant.delivery.manage', 'restaurant.reports.view',
    'restaurant.guest.view', 'restaurant.guest.respond', 'restaurant.guest.qr', 'accommodation.rooms.view', 'accommodation.stays.view',
    'sales.view', 'customers.view', 'customers.create', 'shifts.open', 'shifts.close', 'shifts.view',
    'notifications.view', 'notifications.send', 'tickets.view', 'tickets.create',
  ],
  [ROLES.CHEF]: [
    'restaurant.menu.view', 'restaurant.menu.soldout', 'restaurant.kitchen.view', 'restaurant.kitchen.update', 'restaurant.kitchen.manage', 'restaurant.kitchen.expedite',
    'restaurant.recipes.view', 'restaurant.ingredients.view', 'restaurant.ingredients.waste', 'restaurant.ingredients.count',
    'restaurant.shifts.self', 'notifications.view', 'tickets.view', 'tickets.create',
  ],
  [ROLES.KITCHEN_STAFF]: ['restaurant.menu.view', 'restaurant.kitchen.view', 'restaurant.kitchen.update', 'restaurant.shifts.self', 'notifications.view'],
  [ROLES.BARTENDER]: [
    'restaurant.guest.view', 'restaurant.guest.respond',
    'restaurant.menu.view', 'restaurant.menu.soldout', 'restaurant.kitchen.view', 'restaurant.kitchen.update',
    'restaurant.orders.view', 'restaurant.orders.create', 'restaurant.bills.view', 'restaurant.ingredients.view', 'restaurant.ingredients.waste',
    'restaurant.shifts.self', 'notifications.view',
  ],
  [ROLES.EXPEDITOR]: [
    'restaurant.menu.view', 'restaurant.kitchen.view', 'restaurant.kitchen.update', 'restaurant.kitchen.expedite',
    'restaurant.orders.view', 'restaurant.orders.view_all', 'restaurant.shifts.self', 'notifications.view',
  ],
  [ROLES.RECEPTIONIST]: [
    'accommodation.rooms.view', 'accommodation.rooms.status',
    'accommodation.stays.view', 'accommodation.stays.create', 'accommodation.stays.checkin', 'accommodation.stays.checkout', 'accommodation.stays.manage',
    'accommodation.folio.charge', 'accommodation.folio.pay',
    'accommodation.housekeeping.view', 'accommodation.housekeeping.manage', 'accommodation.reports.view',
    'restaurant.menu.view', 'restaurant.orders.view', 'restaurant.orders.view_all', 'restaurant.orders.create', 'restaurant.bills.view',
    'restaurant.guest.view', 'restaurant.guest.respond', 'restaurant.reservations.view', 'restaurant.reservations.manage',
    'customers.view', 'customers.create', 'shifts.open', 'shifts.close', 'shifts.view',
    'notifications.view', 'tickets.view', 'tickets.create',
  ],
  [ROLES.HOUSEKEEPER]: [
    'accommodation.rooms.view', 'accommodation.housekeeping.view', 'accommodation.housekeeping.update',
    'notifications.view',
  ],
  [ROLES.DELIVERY_RIDER]: ['restaurant.delivery.self', 'restaurant.shifts.self', 'notifications.view'],
};

/** extend({ PERMISSIONS, DEFAULT_ROLE_PERMISSIONS }) -> same shape, with the restaurant additions merged in. */
function extend({ PERMISSIONS, DEFAULT_ROLE_PERMISSIONS }) {
  const all = Object.freeze([...new Set([...PERMISSIONS, ...RESTAURANT_PERMISSIONS])]);
  const roles = { ...DEFAULT_ROLE_PERMISSIONS };
  for (const [role, grants] of Object.entries(ROLE_GRANTS)) roles[role] = [...new Set([...(roles[role] || []), ...grants])];
  roles[ROLES.OWNER] = [...all];
  // ADMIN keeps whatever the base file excluded (e.g. settings.update) and gains every restaurant permission.
  roles[ROLES.ADMIN] = [...new Set([...(DEFAULT_ROLE_PERMISSIONS[ROLES.ADMIN] || []), ...RESTAURANT_PERMISSIONS])];
  return { PERMISSIONS: all, DEFAULT_ROLE_PERMISSIONS: Object.freeze(roles) };
}

module.exports = { RESTAURANT_PERMISSIONS, ROLE_GRANTS, extend };
