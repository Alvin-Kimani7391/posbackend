/**
 * Server-side feature gate. Use AFTER authenticate:
 *   router.use(authenticate, requireFeature('jobCards'));
 *   router.post('/', requireFeature('serialNumberTracking', 'warrantyManagement'), ...)   // ALL must be on
 *
 * Hiding a menu item is not access control; this is. Unlike subscriptionGate this FAILS CLOSED:
 * if we cannot confirm the feature is enabled we refuse.
 * Plan entitlements (paid modules) can be added here later via business.featureEntitlements.
 */
const Business = require('../models/Business');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const { ROLES } = require('../constants/roles');

function requireFeature(...keys) {
  return catchAsync(async (req, res, next) => {
    if (req.user?.role === ROLES.SUPER_ADMIN) return next();
    const businessId = req.businessId;
    if (!businessId) throw ApiError.forbidden('No business context', 'NO_BUSINESS');

    const business = await Business.findById(businessId).select('businessType featureSettings').lean();
    if (!business) throw ApiError.notFound('Business not found');

    const fs = business.featureSettings || {};
    const missing = keys.filter((k) => fs[k] !== true);
    if (missing.length) {
      throw ApiError.forbidden(
        `This feature is not enabled for your business (${missing.join(', ')}).`,
        'FEATURE_DISABLED'
      );
    }
    req.businessType = business.businessType;
    next();
  });
}

module.exports = requireFeature;