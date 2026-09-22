/**
 * permissionCheck.js
 * Server-side mirror of the role -> permission logic used by
 * middleware/auth.js's requirePermission(). Use this ONLY to shape the
 * content of an already-authenticated, self-scoped response (e.g. "include
 * inventory alerts only if this user could also reach them via their own
 * gated endpoint"). It must never replace requirePermission() on a route -
 * that middleware is the actual security boundary.
 */
const { DEFAULT_ROLE_PERMISSIONS } = require('../constants/permissions');
const { ROLES } = require('../constants/roles');

function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN) return true;
  if ((user.revokedPermissions || []).includes(permission)) return false;
  const defaults = DEFAULT_ROLE_PERMISSIONS[user.role] || [];
  return defaults.includes(permission) || (user.grantedPermissions || []).includes(permission);
}

module.exports = { hasPermission, ROLES };