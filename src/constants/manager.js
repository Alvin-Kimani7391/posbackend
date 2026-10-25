/** Manager / owner command centre. OWNER, ADMIN, MANAGER only, and they must hold a reports permission. */
const { ROLES } = require('./roles');
const MANAGER_DASHBOARD_ROLES = Object.freeze([ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER]);
const CHANNELS = Object.freeze({
  DINE_IN: 'Dine in (waiter)', TAKEAWAY: 'Take away / pickup', SELF_SERVICE: 'Self service (kiosk)', ONLINE: 'Online / store',
  DELIVERY: 'Delivery (phone / staff)', QR_ORDER: 'Guest QR order', ROOM_SERVICE: 'Room service', COUNTER: 'Counter / bar tab',
});
module.exports = { MANAGER_DASHBOARD_ROLES, CHANNELS };