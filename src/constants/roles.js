const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',   // <-- add
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  STOREKEEPER: 'STOREKEEPER',
  ACCOUNTANT: 'ACCOUNTANT',

  // --- restaurant roles (docs/business-requirements/07-restaurant.md) ---
  SUPERVISOR: 'SUPERVISOR',
  HEAD_WAITER: 'HEAD_WAITER',
  WAITER: 'WAITER',
  CHEF: 'CHEF',
  KITCHEN_STAFF: 'KITCHEN_STAFF',
  BARTENDER: 'BARTENDER',
  EXPEDITOR: 'EXPEDITOR',
  DELIVERY_RIDER: 'DELIVERY_RIDER',
  RECEPTIONIST: 'RECEPTIONIST',   // accommodation: front desk (bookings, check-in / check-out, folios)
  HOUSEKEEPER: 'HOUSEKEEPER',     // accommodation: cleans rooms, reports maintenance
  PHARMACIST: 'PHARMACIST',     // pharmacy: dispensing and clinical review. Still needs a verified pharmacyCredential to dispense.
});

module.exports = { ROLES };