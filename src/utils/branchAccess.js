const ApiError = require('./ApiError');
const { ROLES } = require('../constants/roles');

/** Same rule as middleware/auth.js#requireBranchAccess, for services that touch SEVERAL branches (warehouse in one, shop in another). */
function canAccessBranch(user, branchId) {
  if (!user) return false;
  if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN || user.role === ROLES.SUPER_ADMIN) return true;
  return (user.branchIds || []).some((id) => String(id) === String(branchId));
}
function assertBranchAccess(user, branchId) {
  if (!canAccessBranch(user, branchId)) throw ApiError.forbidden('You do not have access to this branch', 'BRANCH_ACCESS_DENIED');
}
module.exports = { canAccessBranch, assertBranchAccess };
