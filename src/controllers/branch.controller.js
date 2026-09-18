const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const branchService = require('../services/branch.service');

exports.list = catchAsync(async (req, res) => {
  const result = await branchService.listBranches(req.businessId, req.query);
  return sendSuccess(res, 200, 'Branches fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const branch = await branchService.getBranch(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Branch fetched', { branch });
});

exports.create = catchAsync(async (req, res) => {
  const branch = await branchService.createBranch(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Branch created', { branch });
});

exports.update = catchAsync(async (req, res) => {
  const branch = await branchService.updateBranch(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Branch updated', { branch });
});

exports.remove = catchAsync(async (req, res) => {
  const branch = await branchService.deleteBranch(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Branch deactivated', { branch });
});
