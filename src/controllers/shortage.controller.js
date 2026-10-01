const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/ApiResponse');
const shortageService = require('../services/shortage.service');
const { hasPermission } = require('../utils/permissionCheck');
const { ROLES } = require('../constants/roles');

// Owner/Admin/anyone with shortages.manage sees every cashier; everyone else
// (cashiers, accountants with only shortages.view) is locked to their OWN records.
const canSeeAll = (user) => user.role === ROLES.OWNER || user.role === ROLES.ADMIN || hasPermission(user, 'shortages.manage');

function scoped(req) {
  const query = { ...req.query };
  if (!canSeeAll(req.user)) query.cashierId = String(req.user._id);
  return query;
}

exports.list = catchAsync(async (req, res) => {
  const result = await shortageService.listShortages(req.businessId, scoped(req));
  return sendSuccess(res, 200, 'Shortages fetched', result);
});

exports.summary = catchAsync(async (req, res) => {
  const result = await shortageService.getCashierSummary(req.businessId, scoped(req));
  return sendSuccess(res, 200, 'Shortage summary fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const result = await shortageService.getShortage(req.businessId, req.params.id);
  if (!canSeeAll(req.user) && String(result.shortage.cashierId?._id || result.shortage.cashierId) !== String(req.user._id)) {
    throw ApiError.notFound('Shortage not found');
  }
  return sendSuccess(res, 200, 'Shortage fetched', result);
});

exports.pay = catchAsync(async (req, res) => {
  const result = await shortageService.recordPayment(req.businessId, req.user, req.params.id, req.body);
  const message = result.shortage.status === 'CLEARED' ? 'Shortage cleared' : 'Payment recorded';
  return sendSuccess(res, 201, message, result);
});