const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',   // <-- add
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  STOREKEEPER: 'STOREKEEPER',
  ACCOUNTANT: 'ACCOUNTANT',
  PHARMACIST: 'PHARMACIST',     // pharmacy: dispensing and clinical review. Still needs a verified pharmacyCredential to dispense.
});

module.exports = { ROLES };