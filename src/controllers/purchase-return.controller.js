const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const service = require('../services/purchase-return.service');

exports.list = catchAsync(async (req, res) => sendSuccess(res, 200, 'Purchase returns fetched', await service.listReturns(req.businessId, req.query)));
exports.summary = catchAsync(async (req, res) => sendSuccess(res, 200, 'Summary fetched', await service.summary(req.businessId, req.query)));
exports.eligible = catchAsync(async (req, res) => sendSuccess(res, 200, 'Return options fetched', await service.eligibility(req.businessId, req.params.id)));
exports.getOne = catchAsync(async (req, res) => sendSuccess(res, 200, 'Purchase return fetched', { purchaseReturn: await service.getReturn(req.businessId, req.params.id) }));
exports.create = catchAsync(async (req, res) => sendSuccess(res, 201, 'Purchase returned to supplier', { purchaseReturn: await service.createReturn(req.businessId, req.user._id, req.params.id, req.body) }));
exports.recordRefund = catchAsync(async (req, res) => sendSuccess(res, 200, 'Refund recorded', { purchaseReturn: await service.recordRefund(req.businessId, req.user._id, req.params.id, req.body) }));
exports.holdCredit = catchAsync(async (req, res) => sendSuccess(res, 200, 'Credit kept with the supplier', { purchaseReturn: await service.holdAsCredit(req.businessId, req.user._id, req.params.id, req.body) }));