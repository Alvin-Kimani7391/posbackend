const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const svc = require('../services/warehouse.service');

exports.listWarehouse = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Warehouse stock fetched', await svc.listWarehouseInventory(req.businessId, req.query.branchId || req.branchId, req.query)));

exports.overview = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Stock overview fetched', await svc.stockOverview(req.businessId, req.query.branchId || req.branchId, req.query)));

exports.transfer = catchAsync(async (req, res) =>
  sendSuccess(res, 201, 'Stock moved', { transfer: await svc.transferBetweenLocations(req.businessId, req.user._id, req.body) }));

exports.listTransfers = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Transfers fetched', await svc.listLocationTransfers(req.businessId, req.query)));

exports.getTransfer = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Transfer fetched', { transfer: await svc.getLocationTransfer(req.businessId, req.params.id) }));

exports.reconcile = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Reconciliation done', await svc.reconcile(req.businessId, req.query.branchId || req.branchId)));
