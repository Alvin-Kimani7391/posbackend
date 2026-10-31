const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const svc = require('../services/saleHistory.service');

exports.list = catchAsync(async (req, res) => sendSuccess(res, 200, 'Sales fetched', await svc.list(req.businessId, req.user, req.query)));
exports.detail = catchAsync(async (req, res) => sendSuccess(res, 200, 'Sale fetched', await svc.detail(req.businessId, req.user, req.params.id)));
