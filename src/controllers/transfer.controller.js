const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const transferService = require('../services/transfer.service');

exports.list = catchAsync(async (req, res) => {
  const result = await transferService.listTransfers(req.businessId, req.query);
  return sendSuccess(res, 200, 'Transfers fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const transfer = await transferService.getTransfer(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Transfer fetched', { transfer });
});

exports.create = catchAsync(async (req, res) => {
  const transfer = await transferService.requestTransfer(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Transfer requested', { transfer });
});

exports.approve = catchAsync(async (req, res) => {
  const transfer = await transferService.approveTransfer(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Transfer approved', { transfer });
});

exports.dispatch = catchAsync(async (req, res) => {
  const transfer = await transferService.dispatchTransfer(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Transfer dispatched', { transfer });
});

exports.receive = catchAsync(async (req, res) => {
  const transfer = await transferService.receiveTransfer(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Transfer received', { transfer });
});

exports.cancel = catchAsync(async (req, res) => {
  const transfer = await transferService.cancelTransfer(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Transfer cancelled', { transfer });
});
