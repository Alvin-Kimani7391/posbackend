const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const admin = require('../services/admin.service');

exports.overview = catchAsync(async (req, res) => sendSuccess(res, 200, 'Overview fetched', await admin.getOverview(req.query)));

exports.listBusinesses = catchAsync(async (req, res) => sendSuccess(res, 200, 'Businesses fetched', await admin.listBusinesses(req.query)));
exports.getBusiness = catchAsync(async (req, res) => sendSuccess(res, 200, 'Business fetched', await admin.getBusiness(req.params.id)));
exports.setBusinessStatus = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Business status updated', await admin.setBusinessStatus(req.user, req.params.id, req.body.status)));

exports.listSales = catchAsync(async (req, res) => sendSuccess(res, 200, 'Sales fetched', await admin.listSales(req.query)));
exports.getSale = catchAsync(async (req, res) => sendSuccess(res, 200, 'Sale fetched', await admin.getSale(req.params.id)));

exports.listEmployees = catchAsync(async (req, res) => sendSuccess(res, 200, 'Employees fetched', await admin.listEmployees(req.query)));
exports.setEmployeeStatus = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Employee status updated', await admin.setEmployeeStatus(req.user, req.params.id, req.body.status)));

exports.listProducts = catchAsync(async (req, res) => sendSuccess(res, 200, 'Products fetched', await admin.listProducts(req.query)));
exports.listAuditLogs = catchAsync(async (req, res) => sendSuccess(res, 200, 'Audit logs fetched', await admin.listAuditLogs(req.query)));