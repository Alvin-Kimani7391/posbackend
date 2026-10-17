const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const layaways = require('../services/layaway.service');
const tradeIns = require('../services/tradein.service');

// ---- layaway
exports.create = catchAsync(async (req, res) => sendSuccess(res, 201, 'Layaway opened', { layaway: await layaways.create(req.businessId, req.body.branchId, req.user, req.body) }));
exports.list = catchAsync(async (req, res) => sendSuccess(res, 200, 'Layaways fetched', await layaways.list(req.businessId, req.query)));
exports.summary = catchAsync(async (req, res) => sendSuccess(res, 200, 'Layaway summary fetched', await layaways.summary(req.businessId, req.query)));
exports.get = catchAsync(async (req, res) => sendSuccess(res, 200, 'Layaway fetched', { layaway: await layaways.getLayaway(req.businessId, req.params.id) }));
exports.pay = catchAsync(async (req, res) => sendSuccess(res, 200, 'Payment recorded', { layaway: await layaways.recordPayment(req.businessId, req.user, req.params.id, req.body) }));
exports.extend = catchAsync(async (req, res) => sendSuccess(res, 200, 'Due date extended', { layaway: await layaways.extend(req.businessId, req.user, req.params.id, req.body) }));
exports.collect = catchAsync(async (req, res) => sendSuccess(res, 200, 'Goods handed over', { layaway: await layaways.collect(req.businessId, req.user, req.params.id, req.body) }));
exports.cancel = catchAsync(async (req, res) => sendSuccess(res, 200, 'Layaway cancelled', { layaway: await layaways.cancel(req.businessId, req.user, req.params.id, req.body) }));

// ---- trade-ins
exports.appraise = catchAsync(async (req, res) => sendSuccess(res, 201, 'Trade-in appraised', { tradeIn: await tradeIns.appraise(req.businessId, req.body.branchId, req.user, req.body) }));
exports.listTradeIns = catchAsync(async (req, res) => sendSuccess(res, 200, 'Trade-ins fetched', await tradeIns.list(req.businessId, req.query)));
exports.getTradeIn = catchAsync(async (req, res) => sendSuccess(res, 200, 'Trade-in fetched', { tradeIn: await tradeIns.getTradeIn(req.businessId, req.params.id) }));
exports.approveTradeIn = catchAsync(async (req, res) => sendSuccess(res, 200, 'Offer approved', { tradeIn: await tradeIns.approve(req.businessId, req.user, req.params.id) }));
exports.acceptTradeIn = catchAsync(async (req, res) => sendSuccess(res, 200, 'Offer accepted', { tradeIn: await tradeIns.accept(req.businessId, req.user, req.params.id, req.body) }));
exports.cancelTradeIn = catchAsync(async (req, res) => sendSuccess(res, 200, 'Trade-in cancelled', { tradeIn: await tradeIns.cancel(req.businessId, req.user, req.params.id, req.body) }));