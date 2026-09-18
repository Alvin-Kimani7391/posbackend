const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const employeeService = require('../services/employee.service');

exports.list = catchAsync(async (req, res) => {
  const result = await employeeService.listEmployees(req.businessId, req.query);
  return sendSuccess(res, 200, 'Employees fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const user = await employeeService.getEmployee(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Employee fetched', { user: user.toSafeJSON() });
});

exports.create = catchAsync(async (req, res) => {
  const user = await employeeService.createEmployee(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Employee created', { user: user.toSafeJSON() });
});

exports.update = catchAsync(async (req, res) => {
  const user = await employeeService.updateEmployee(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Employee updated', { user: user.toSafeJSON() });
});

exports.setStatus = catchAsync(async (req, res) => {
  const user = await employeeService.setEmployeeStatus(req.businessId, req.user._id, req.params.id, req.body.status);
  return sendSuccess(res, 200, 'Employee status updated', { user: user.toSafeJSON() });
});

exports.remove = catchAsync(async (req, res) => {
  const user = await employeeService.deleteEmployee(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Employee deactivated', { user: user.toSafeJSON() });
});
