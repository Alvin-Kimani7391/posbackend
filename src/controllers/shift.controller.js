const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const registerService = require('../services/register.service');
const shiftService = require('../services/shift.service');

exports.listRegisters = catchAsync(async (req, res) => {
  const registers = await registerService.listRegisters(req.businessId, req.query.branchId);
  return sendSuccess(res, 200, 'Registers fetched', { registers });
});

exports.createRegister = catchAsync(async (req, res) => {
  const register = await registerService.createRegister(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Register created', { register });
});

exports.updateRegister = catchAsync(async (req, res) => {
  const register = await registerService.updateRegister(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Register updated', { register });
});

exports.current = catchAsync(async (req, res) => {
  const shift = await shiftService.getCurrentShift(req.businessId, req.query.branchId, req.user._id);
  return sendSuccess(res, 200, 'Current shift fetched', { shift });
});

exports.list = catchAsync(async (req, res) => {
  const result = await shiftService.listShifts(req.businessId, req.query);
  return sendSuccess(res, 200, 'Shifts fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const shift = await shiftService.getShift(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Shift fetched', { shift });
});

exports.open = catchAsync(async (req, res) => {
  const shift = await shiftService.openShift(req.businessId, req.body.branchId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Shift opened', { shift });
});

exports.close = catchAsync(async (req, res) => {
  const shift = await shiftService.closeShift(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Shift closed', { shift });
});
