const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const supplierService = require('../services/supplier.service');

exports.list = catchAsync(async (req, res) => {
  const result = await supplierService.listSuppliers(req.businessId, req.query);
  return sendSuccess(res, 200, 'Suppliers fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const supplier = await supplierService.getSupplier(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Supplier fetched', { supplier });
});

exports.create = catchAsync(async (req, res) => {
  const supplier = await supplierService.createSupplier(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Supplier created', { supplier });
});

exports.update = catchAsync(async (req, res) => {
  const supplier = await supplierService.updateSupplier(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Supplier updated', { supplier });
});
