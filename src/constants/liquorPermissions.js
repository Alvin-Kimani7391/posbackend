const { ROLES } = require('./roles');
const LIQUOR_PERMISSIONS = Object.freeze([
  'liquor.settings',   // licence, trading hours, dry days, age policy, empties mode
  'liquor.products',   // liquor details on products (ABV, volume, containers, tots)
  'liquor.override',   // sell outside hours / on a dry day / over the per-sale limit (reason is logged)
  'liquor.empties',    // refund deposits, receive from / return empties to suppliers
  'liquor.tots',       // dip counts, waste and comps for open bottles
  'liquor.reports',    // compliance + volume reports, age-check log
]);
const ROLE_GRANTS = {
  [ROLES.MANAGER]: [...LIQUOR_PERMISSIONS],
  [ROLES.CASHIER]: [],
  [ROLES.STOREKEEPER]: ['liquor.products', 'liquor.empties'],
  [ROLES.ACCOUNTANT]: ['liquor.reports'],
};
function extend({ PERMISSIONS, DEFAULT_ROLE_PERMISSIONS }) {
  const all = Object.freeze([...new Set([...PERMISSIONS, ...LIQUOR_PERMISSIONS])]);
  const roles = { ...DEFAULT_ROLE_PERMISSIONS };
  for (const [role, grants] of Object.entries(ROLE_GRANTS)) roles[role] = [...new Set([...(roles[role] || []), ...grants])];
  roles[ROLES.OWNER] = [...all];
  roles[ROLES.ADMIN] = [...new Set([...(DEFAULT_ROLE_PERMISSIONS[ROLES.ADMIN] || []), ...LIQUOR_PERMISSIONS])];
  return { PERMISSIONS: all, DEFAULT_ROLE_PERMISSIONS: Object.freeze(roles) };
}
module.exports = { LIQUOR_PERMISSIONS, ROLE_GRANTS, extend };
