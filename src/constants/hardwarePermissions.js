const { ROLES } = require('./roles');
const HARDWARE_PERMISSIONS = Object.freeze([
  'hardware.profile',         // specs, dimensions, divisibility, alternatives, locations on products
  'hardware.pricing',         // contractor prices and quantity breaks
  'hardware.quotes',          // create / edit / send quotations, projects
  'hardware.quotes.approve',  // approve a quotation (becomes an order, reserves stock)
  'hardware.quotes.reprice',  // convert a quotation at today's prices instead of the locked prices
  'hardware.deliveries',      // schedule deliveries, assign vehicle and driver, see all deliveries
  'hardware.deliver',         // driver: see own deliveries, update status, record proof
  'hardware.locations',       // rack / shelf / bin locations, pick lists
  'hardware.remnants',        // write off offcuts, damaged material and scrap (reason is logged)
  'hardware.settings',        // quotation validity, reservation rules
  'hardware.reports',
  'hardware.transport',          // fleet, rate card, transport price, transport report
  'hardware.transport.manage',   // vehicles, rates, vehicle costs, refunds, negotiated prices, vehicle overrides
  'hardware.transport.costs',    // record fuel / allowance / toll costs on a job (a driver: own jobs only)
  'hardware.boq',                // bill of quantities for a project
  'hardware.supplier',           // supplier quotations, comparison, landed costs
  'hardware.templates',          // product templates and custom attributes
  'hardware.deposits',           // take customer deposits and part payments
  'hardware.deposits.refund',    // refund a deposit
  'hardware.finance',            // operating profit, budgets, recurring expenses, expense classification
  'hardware.repack',             // repackage bulk stock into smaller sellable products
]);
const ROLE_GRANTS = {
  [ROLES.MANAGER]: [...HARDWARE_PERMISSIONS],
  [ROLES.CASHIER]: ['hardware.quotes', 'hardware.deposits'],
  [ROLES.SALES_REP]: ['hardware.quotes', 'sales.create', 'sales.view', 'customers.view', 'customers.create', 'products.view', 'inventory.view', 'notifications.view', 'hardware.boq', 'hardware.deposits'],
  [ROLES.STOREKEEPER]: ['hardware.profile', 'hardware.locations', 'hardware.remnants', 'hardware.deliveries', 'hardware.repack', 'hardware.supplier'],
  [ROLES.DISPATCHER]: ['hardware.deliveries', 'hardware.transport', 'hardware.transport.costs', 'hardware.locations', 'sales.view', 'customers.view', 'notifications.view'],
  [ROLES.DRIVER]: ['hardware.deliver', 'hardware.transport.costs', 'notifications.view'],
  [ROLES.ACCOUNTANT]: ['hardware.reports', 'hardware.finance', 'hardware.transport', 'hardware.deposits', 'hardware.supplier'],
};
function extend({ PERMISSIONS, DEFAULT_ROLE_PERMISSIONS }) {
  const all = Object.freeze([...new Set([...PERMISSIONS, ...HARDWARE_PERMISSIONS])]);
  const roles = { ...DEFAULT_ROLE_PERMISSIONS };
  for (const [role, grants] of Object.entries(ROLE_GRANTS)) roles[role] = [...new Set([...(roles[role] || []), ...grants])];
  roles[ROLES.OWNER] = [...all];
  roles[ROLES.ADMIN] = [...new Set([...(DEFAULT_ROLE_PERMISSIONS[ROLES.ADMIN] || []), ...HARDWARE_PERMISSIONS])];
  return { PERMISSIONS: all, DEFAULT_ROLE_PERMISSIONS: Object.freeze(roles) };
}
module.exports = { HARDWARE_PERMISSIONS, ROLE_GRANTS, extend };
