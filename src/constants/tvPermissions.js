const { ROLES } = require('./roles');
const TV_PERMISSIONS = Object.freeze(['tv.view', 'tv.manage', 'tv.publish', 'tv.screens']);
const GRANTS = {
  [ROLES.MANAGER]: [...TV_PERMISSIONS],
  [ROLES.SUPERVISOR]: ['tv.view'],
  [ROLES.HEAD_WAITER]: ['tv.view'],
  [ROLES.RECEPTIONIST]: ['tv.view'],
};
function extend({ PERMISSIONS, DEFAULT_ROLE_PERMISSIONS }) {
  const all = Object.freeze([...new Set([...PERMISSIONS, ...TV_PERMISSIONS])]);
  const roles = { ...DEFAULT_ROLE_PERMISSIONS };
  for (const [r, g] of Object.entries(GRANTS)) roles[r] = [...new Set([...(roles[r] || []), ...g])];
  roles[ROLES.OWNER] = [...new Set([...(roles[ROLES.OWNER] || []), ...TV_PERMISSIONS])];
  roles[ROLES.ADMIN] = [...new Set([...(roles[ROLES.ADMIN] || []), ...TV_PERMISSIONS])];
  return { PERMISSIONS: all, DEFAULT_ROLE_PERMISSIONS: Object.freeze(roles) };
}
module.exports = { TV_PERMISSIONS, extend };
