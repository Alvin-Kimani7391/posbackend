/** Use AFTER authenticate. OWNER/ADMIN/MANAGER only, plus a reports permission. */
const ApiError = require('../utils/ApiError');
const { MANAGER_DASHBOARD_ROLES } = require('../constants/manager');
const { hasPermission } = require('../utils/permissionCheck');
module.exports = function requireManagerRole(req, res, next) {
  if (!req.user) return next(ApiError.unauthorized());
  if (!MANAGER_DASHBOARD_ROLES.includes(req.user.role)) return next(ApiError.forbidden('The manager dashboard is for the owner and managers only.', 'MANAGER_ROLE_REQUIRED'));
  if (!hasPermission(req.user, 'restaurant.reports.view') && !hasPermission(req.user, 'accommodation.reports.view')) return next(ApiError.forbidden('Missing permission: restaurant.reports.view', 'PERMISSION_DENIED'));
  next();
};