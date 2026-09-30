const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const { verifyAccessToken } = require('../utils/tokens');
const User = require('../models/User');
const Business = require('../models/Business');
const { ROLES } = require('../constants/roles');
const { DEFAULT_ROLE_PERMISSIONS } = require('../constants/permissions');

/**
 * Verifies the JWT, loads the user, and attaches req.user + req.businessId.
 * req.businessId is ALWAYS derived from the token/user record, never from the
 * request body/query/params. Downstream code must use req.businessId, not
 * anything supplied by the client.
 *
 * SUPER_ADMIN (platform admin) has no business: req.businessId is null, and
 * tenant routes reject them through requirePermission (no default permissions).
 */
const authenticate = catchAsync(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    throw ApiError.unauthorized('Missing access token');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    throw ApiError.unauthorized('Invalid or expired access token');
  }

  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('Account is inactive or no longer exists');
  }

  // Platform admin: no business, no tenant scope.
  if (user.role === ROLES.SUPER_ADMIN) {
    req.user = user;
    req.businessId = null;
    return next();
  }

  // Defense in depth: the businessId embedded in the token must still match
  // the user's current business record.
  if (!user.businessId || user.businessId.toString() !== payload.businessId) {
    throw ApiError.unauthorized('Token/business mismatch');
  }

  // A suspended business is locked out on its very next request,
  // even with a still-valid access token.
  const business = await Business.findById(user.businessId).select('status').lean();
  if (!business || business.status !== 'active') {
    throw ApiError.forbidden('This business account is suspended. Contact support.', 'BUSINESS_SUSPENDED');
  }

  req.user = user;
  req.businessId = user.businessId; // <-- authoritative source of truth everywhere downstream
  next();
});

/** Platform-admin-only gate. Use AFTER authenticate. */
function requireSuperAdmin(req, res, next) {
  if (!req.user) return next(ApiError.unauthorized());
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    return next(ApiError.forbidden('Platform admin access only', 'SUPER_ADMIN_ONLY'));
  }
  next();
}

/** Restrict a route to specific roles. Owner is never blocked by this. */
function authorizeRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role === ROLES.OWNER || allowedRoles.includes(req.user.role)) {
      return next();
    }
    return next(ApiError.forbidden(`Requires role: ${allowedRoles.join(' or ')}`));
  };
}

function userHasPermission(user, permission) {
  if (user.role === ROLES.OWNER) return true;
  if (user.revokedPermissions?.includes(permission)) return false;
  const defaults = DEFAULT_ROLE_PERMISSIONS[user.role] || [];
  return defaults.includes(permission) || user.grantedPermissions?.includes(permission);
}

/** Requires the authenticated user to hold a specific granular permission. */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!userHasPermission(req.user, permission)) {
      return next(ApiError.forbidden(`Missing permission: ${permission}`, 'PERMISSION_DENIED'));
    }
    next();
  };
}

/**
 * Ensures the authenticated user is allowed to act on the branch referenced
 * by the request (params.branchId, body.branchId, or query.branchId, in that
 * order). OWNER/ADMIN implicitly have access to every branch in their
 * business; other roles must be explicitly assigned to the branch.
 */
function requireBranchAccess(req, res, next) {
  const branchId = req.params.branchId || req.body.branchId || req.query.branchId;

  if (!branchId) {
    // Some routes (e.g. business-wide reports) legitimately have no branch scope.
    return next();
  }

  if (!mongoose.Types.ObjectId.isValid(branchId)) {
    return next(ApiError.badRequest('Invalid branchId', 'INVALID_BRANCH_ID'));
  }

  const { user } = req;
  const isBranchWideRole = user.role === ROLES.OWNER || user.role === ROLES.ADMIN;
  const assigned = (user.branchIds || []).some((id) => id.toString() === branchId.toString());

  if (!isBranchWideRole && !assigned) {
    return next(ApiError.forbidden('You do not have access to this branch', 'BRANCH_ACCESS_DENIED'));
  }

  req.branchId = branchId;
  next();
}

module.exports = {
  authenticate,
  authorizeRole,
  requirePermission,
  requireBranchAccess,
  requireSuperAdmin,
  userHasPermission,
};