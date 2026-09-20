const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const saleService = require('../services/sale.service');
const receiptService = require('../services/receipt.service');

exports.create = catchAsync(async (req, res) => {
  const result = await saleService.createSale(req.businessId, req.body.branchId, req.user, req.body);
  return sendSuccess(res, 201, result.replayed ? 'Sale already recorded' : 'Sale completed', result);
});

exports.list = catchAsync(async (req, res) => {
  const result = await saleService.listSales(req.businessId, req.query);
  return sendSuccess(res, 200, 'Sales fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const result = await saleService.getSale(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Sale fetched', result);
});

exports.cancel = catchAsync(async (req, res) => {
  const sale = await saleService.cancelSale(req.businessId, req.user._id, req.params.id, req.body.reason);
  return sendSuccess(res, 200, 'Sale cancelled', { sale });
});

exports.getReceipt = catchAsync(async (req, res) => {
  const receipt = await receiptService.getReceiptBySale(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Receipt fetched', { receipt });
});

exports.printReceipt = catchAsync(async (req, res) => {
  const receipt = await receiptService.recordPrint(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Print recorded', { receipt });
});
