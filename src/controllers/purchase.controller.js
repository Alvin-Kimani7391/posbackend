const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const purchaseService = require('../services/purchase.service');

exports.list = catchAsync(async (req, res) => {
  const result = await purchaseService.listPurchases(req.businessId, req.query);
  return sendSuccess(res, 200, 'Purchases fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const purchase = await purchaseService.getPurchase(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Purchase fetched', { purchase });
});

exports.create = catchAsync(async (req, res) => {
  const purchase = await purchaseService.createPurchase(req.businessId, req.body.branchId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Purchase created', { purchase });
});

exports.receive = catchAsync(async (req, res) => {
  const purchase = await purchaseService.receivePurchase(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Purchase received', { purchase });
});

exports.recordPayment = catchAsync(async (req, res) => {
  const purchase = await purchaseService.recordPurchasePayment(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Payment recorded', { purchase });
});
