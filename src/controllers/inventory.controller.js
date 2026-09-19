const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const inventoryService = require('../services/inventory.service');

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
