/**
 * Role gate for the cashier dashboard. Use AFTER authenticate.
 * Only OWNER, MANAGER and CASHIER (constants/cashier.js) get through; every other role, ADMIN and the platform admin included, gets 403.
 * This is separate from requirePermission on purpose: OWNER/ADMIN hold every permission, so a permission alone cannot express "these three roles".
 */
const ApiError = require('../utils/ApiError');
const { CASHIER_DASHBOARD_ROLES } = require('../constants/cashier');

module.exports = function requireCashierRole(req, res, next) {
  if (!req.user) return next(ApiError.unauthorized());
  if (!CASHIER_DASHBOARD_ROLES.includes(req.user.role)) {
    return next(ApiError.forbidden('The cashier dashboard is for the owner, managers and cashiers only.', 'CASHIER_ROLE_REQUIRED'));
  }
  next();
};
