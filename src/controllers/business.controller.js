const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const businessService = require('../services/business.service');

exports.getBusiness = catchAsync(async (req, res) => {
  const business = await businessService.getOwnBusiness(req.businessId);
  return sendSuccess(res, 200, 'Business fetched', { business });
});

exports.updateBusiness = catchAsync(async (req, res) => {
  const business = await businessService.updateOwnBusiness(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 200, 'Business updated', { business });
});

exports.changeCountry = catchAsync(async (req, res) => {
  const business = await businessService.changeCountry(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 200, 'Country updated', { business });
});

exports.getProfile = catchAsync(async (req, res) => {
  const profile = await businessService.getProfile(req.businessId);
  return sendSuccess(res, 200, 'Business profile fetched', { profile });
});

exports.getTypes = catchAsync(async (req, res) => {
  return sendSuccess(res, 200, 'Business types fetched', businessService.getTypeCatalogue());
});

exports.getOnboarding = catchAsync(async (req, res) => {
  const onboarding = await businessService.getOnboarding(req.businessId);
  return sendSuccess(res, 200, 'Setup guide fetched', { onboarding });
});

exports.updateOnboarding = catchAsync(async (req, res) => {
  const onboarding = await businessService.updateOnboarding(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 200, 'Setup guide updated', { onboarding });
});
