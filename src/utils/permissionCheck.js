/**
 * permissionCheck.js
 * Same answer as middleware/auth.js's requirePermission(), for shaping the content of an already-authenticated,
 * self-scoped response. It must never replace requirePermission() on a route - that middleware is the security boundary.
 */
const { userHasPermission } = require('./permissionResolver');
const { ROLES } = require('../constants/roles');

function hasPermission(user, permission) {
  return !!user && userHasPermission(user, permission);
}

module.exports = { hasPermission, ROLES };
