const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const refundService = require('../services/refund.service');

exports.list = catchAsync(async (req, res) => {
  const result = await refundService.listRefunds(req.businessId, req.query);
  return sendSuccess(res, 200, 'Refunds fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const refund = await refundService.getRefund(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Refund fetched', { refund });
});

exports.create = catchAsync(async (req, res) => {
  const result = await refundService.requestRefund(req.businessId, req.body.branchId, req.user, req.body);
  return sendSuccess(res, 201, 'Refund submitted', result.refund ? result : { refund: result });
});

exports.approve = catchAsync(async (req, res) => {
  const result = await refundService.approveRefund(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Refund approved and completed', result);
});

exports.reject = catchAsync(async (req, res) => {
  const refund = await refundService.rejectRefund(req.businessId, req.user._id, req.params.id, req.body.rejectionReason);
  return sendSuccess(res, 200, 'Refund rejected', { refund });
});
