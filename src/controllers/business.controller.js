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
