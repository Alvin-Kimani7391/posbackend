/** Paid add-on gate (after authenticate + requireFeature): router.use(authenticate, requireFeature('x'), requireAddon('livetv')). Unsold add-ons are free. */
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const ent = require('../services/addon.entitlement');
module.exports = (...keys) => catchAsync(async (req, res, next) => {
  if (req.user?.role === ROLES.SUPER_ADMIN) return next();
  if (!req.businessId) throw ApiError.forbidden('No business context', 'NO_BUSINESS');
  await ent.assertEntitled(req.businessId, ...keys);
  next();
});
