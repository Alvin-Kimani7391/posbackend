/**
 * Country gate for integrations that only exist in some countries (PayHero M-PESA STK, KRA eTIMS,
 * Kenyan SMS sender IDs...). Use AFTER authenticate:
 *   router.use(authenticate, requireCountry('KE'));
 * Fails CLOSED with 403 COUNTRY_NOT_SUPPORTED so a Tanzanian business can never reach a Kenya-only flow.
 */
const ApiError = require('../utils/ApiError');
const catchAsync = require('./../utils/catchAsync');
const { ROLES } = require('../constants/roles');
const { getBusinessContext } = require('../utils/businessContext');

function requireCountry(...codes) {
  return catchAsync(async (req, res, next) => {
    if (req.user && req.user.role === ROLES.SUPER_ADMIN) return next();
    if (!req.businessId) throw ApiError.forbidden('No business context', 'NO_BUSINESS');
    const ctx = await getBusinessContext(req.businessId);
    if (!codes.includes(ctx.countryCode)) {
      throw ApiError.forbidden(`This feature is not available in ${ctx.country.name} yet.`, 'COUNTRY_NOT_SUPPORTED');
    }
    next();
  });
}

/** Same check, for service code: throws unless the business's country is one of `codes`. */
async function assertCountry(businessId, ...codes) {
  const ctx = await getBusinessContext(businessId);
  if (!codes.includes(ctx.countryCode)) {
    throw ApiError.forbidden(`This feature is not available in ${ctx.country.name} yet.`, 'COUNTRY_NOT_SUPPORTED');
  }
  return ctx;
}

module.exports = requireCountry;
module.exports.assertCountry = assertCountry;
