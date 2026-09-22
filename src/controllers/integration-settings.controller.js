const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const service = require('../services/integration-settings.service');

exports.getStatus = catchAsync(async (req, res) => sendSuccess(res, 200, 'Integration settings fetched', await service.getStatus(req.businessId)));
exports.getFlags = catchAsync(async (req, res) => sendSuccess(res, 200, 'Integration flags fetched', await service.getFlagsForPos(req.businessId)));
exports.updateMpesa = catchAsync(async (req, res) => sendSuccess(res, 200, 'M-PESA settings updated', await service.updateMpesa(req.businessId, req.user, req.body)));
exports.updateEtims = catchAsync(async (req, res) => sendSuccess(res, 200, 'eTIMS settings updated', await service.updateEtims(req.businessId, req.user, req.body)));
exports.testMpesa = catchAsync(async (req, res) => sendSuccess(res, 200, 'Tested', await service.testMpesa(req.businessId, req.user)));
exports.testEtims = catchAsync(async (req, res) => sendSuccess(res, 200, 'Tested', await service.testEtims(req.businessId, req.user)));