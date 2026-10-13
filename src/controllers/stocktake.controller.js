const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const svc = require('../services/stocktake.service');
const { hasPermission } = require('../utils/permissionCheck');

// Only people who can approve see system quantities during a blind count.
const canSeeSystem = (req) => {
  try { return !!hasPermission(req.user, 'stocktake.approve'); } catch { return false; }
};

exports.create = catchAsync(async (req, res) => {
  const doc = await svc.createStocktake(req.businessId, req.body.branchId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Stocktake started', { stocktake: await svc.getStocktake(req.businessId, doc._id, { hideSystem: !canSeeSystem(req) }) });
});
exports.list = catchAsync(async (req, res) => sendSuccess(res, 200, 'Stocktakes fetched', await svc.listStocktakes(req.businessId, req.query)));
exports.getOne = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Stocktake fetched', { stocktake: await svc.getStocktake(req.businessId, req.params.id, { hideSystem: !canSeeSystem(req) }) }));
exports.count = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Counts saved', await svc.recordCounts(req.businessId, req.user._id, req.params.id, req.body.counts)));
exports.submit = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Stocktake submitted for review', { stocktake: await svc.submitStocktake(req.businessId, req.user._id, req.params.id, req.body) }));
exports.approve = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Stocktake approved and stock adjusted', { stocktake: await svc.approveStocktake(req.businessId, req.user, req.params.id, req.body) }));
exports.cancel = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Stocktake cancelled', { stocktake: await svc.cancelStocktake(req.businessId, req.user._id, req.params.id, req.body) }));