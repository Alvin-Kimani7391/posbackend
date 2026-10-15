const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const svc = require('../services/warehouse.service');

const bid = (req) => req.query.branchId || req.body?.branchId || req.branchId;

exports.listWarehouses = catchAsync(async (req, res) => sendSuccess(res, 200, 'Warehouses fetched', await svc.listWarehouses(req.businessId, req.user, req.query)));
exports.getWarehouse = catchAsync(async (req, res) => sendSuccess(res, 200, 'Warehouse fetched', { warehouse: await svc.getWarehouse(req.businessId, req.user, req.params.id) }));
exports.createWarehouse = catchAsync(async (req, res) => sendSuccess(res, 201, 'Warehouse created', { warehouse: await svc.createWarehouse(req.businessId, req.user, req.body) }));
exports.updateWarehouse = catchAsync(async (req, res) => sendSuccess(res, 200, 'Warehouse updated', { warehouse: await svc.updateWarehouse(req.businessId, req.user, req.params.id, req.body) }));
exports.adjust = catchAsync(async (req, res) => sendSuccess(res, 200, 'Warehouse stock adjusted', await svc.adjustWarehouseStock(req.businessId, req.user, req.params.id, req.body)));

exports.listStock = catchAsync(async (req, res) => sendSuccess(res, 200, 'Warehouse stock fetched', await svc.listWarehouseInventory(req.businessId, bid(req), req.query)));
exports.overview = catchAsync(async (req, res) => sendSuccess(res, 200, 'Stock overview fetched', await svc.stockOverview(req.businessId, bid(req), req.query)));
exports.catalog = catchAsync(async (req, res) => sendSuccess(res, 200, 'Wholesale catalog fetched', await svc.wholesaleCatalog(req.businessId, req.user, { ...req.query, branchId: bid(req) })));

exports.transfer = catchAsync(async (req, res) => sendSuccess(res, 201, 'Stock moved', { transfer: await svc.transferBetweenLocations(req.businessId, req.user, req.body) }));
exports.listTransfers = catchAsync(async (req, res) => sendSuccess(res, 200, 'Transfers fetched', await svc.listLocationTransfers(req.businessId, req.query)));
exports.getTransfer = catchAsync(async (req, res) => sendSuccess(res, 200, 'Transfer fetched', { transfer: await svc.getLocationTransfer(req.businessId, req.params.id) }));
exports.reconcile = catchAsync(async (req, res) => sendSuccess(res, 200, 'Reconciliation done', await svc.reconcile(req.businessId, bid(req))));

exports.getSettings = catchAsync(async (req, res) => sendSuccess(res, 200, 'Wholesale settings fetched', { settings: await svc.getWholesaleSettings(req.businessId) }));
exports.updateSettings = catchAsync(async (req, res) => sendSuccess(res, 200, 'Wholesale settings saved', { settings: await svc.updateWholesaleSettings(req.businessId, req.user._id, req.body) }));
