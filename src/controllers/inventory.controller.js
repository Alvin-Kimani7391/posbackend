const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const inventoryService = require('../services/inventory.service');
const unitService = require('../services/unit-conversion.service');

exports.list = catchAsync(async (req, res) => {
  const branchId = req.query.branchId || req.branchId;
  const result = await inventoryService.listBranchInventory(req.businessId, branchId, req.query);
  return sendSuccess(res, 200, 'Inventory fetched', result);
});

exports.lowStock = catchAsync(async (req, res) => {
  const result = await inventoryService.getLowStockAlerts(req.businessId, req.query.branchId);
  return sendSuccess(res, 200, 'Low stock alerts fetched', result);
});

exports.movements = catchAsync(async (req, res) => {
  const result = await inventoryService.getMovements(req.businessId, req.query);
  return sendSuccess(res, 200, 'Movements fetched', result);
});

exports.adjust = catchAsync(async (req, res) => {
  const result = await inventoryService.adjustStock(req.businessId, req.body.branchId, req.user._id, req.body);
  return sendSuccess(res, 200, 'Stock adjusted', result);
});

exports.receive = catchAsync(async (req, res) => {
  const result = await inventoryService.receiveStock(req.businessId, req.body.branchId, req.user._id, req.body);
  return sendSuccess(res, 200, 'Stock received', result);
});

/** Stock value (cents) for the Inventory page: same shared calculation as the dashboard. */
exports.valuation = catchAsync(async (req, res) => {
  const branchId = req.query.branchId || req.branchId;
  const sv = await require('../services/stockValue.service').computeStockValue(req.businessId, { branchId });
  return sendSuccess(res, 200, 'Stock value fetched', { totals: sv.totals, zeroCostList: sv.zeroCostList });
});

/* ---- dynamic unit conversion ---- */
exports.unitEconomics = catchAsync(async (req, res) => {
  const result = await unitService.getEconomics(req.businessId, req.params.productId, { branchId: req.query.branchId || req.branchId, variantId: req.query.variantId });
  return sendSuccess(res, 200, 'Unit price breakdown fetched', result);
});

exports.previewBreak = catchAsync(async (req, res) => {
  const result = await unitService.previewBreakdown(req.businessId, req.body);
  return sendSuccess(res, 200, 'Break-down preview', result);
});

exports.breakDown = catchAsync(async (req, res) => {
  const result = await unitService.breakDown(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Stock broken down', result);
});

exports.listBreaks = catchAsync(async (req, res) => {
  const result = await unitService.listBreakdowns(req.businessId, req.query);
  return sendSuccess(res, 200, 'Break-downs fetched', result);
});
