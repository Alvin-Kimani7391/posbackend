// controllers/etims.controller.js
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const service = require('../services/etims.service');

exports.list = catchAsync(async (req, res) => sendSuccess(res, 200, 'eTIMS transactions fetched', await service.listForBusiness(req.businessId, req.query)));
exports.retry = catchAsync(async (req, res) => sendSuccess(res, 200, 'eTIMS resubmitted', { transaction: await service.retry(req.businessId, req.params.id) }));