const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const svc = require('../services/permission.service');

const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
const ok = (res, msg, data) => sendSuccess(res, 200, msg, data);

exports.me = catchAsync(async (req, res) => ok(res, 'Your permissions', svc.myPermissions(req.user)));
exports.catalog = catchAsync(async (req, res) => ok(res, 'Permission catalog', svc.getCatalogView()));
exports.policy = catchAsync(async (req, res) => ok(res, 'Access policy', await svc.getPolicyView(req.businessId)));

exports.setRole = catchAsync(async (req, res) => { await svc.setRoleTemplate(req.businessId, req.user, req.params.role, req.body, meta(req)); ok(res, 'Role template saved', await svc.getPolicyView(req.businessId)); });
exports.resetRole = catchAsync(async (req, res) => { await svc.resetRoleTemplate(req.businessId, req.user, req.params.role, meta(req)); ok(res, 'Role reset to system defaults', await svc.getPolicyView(req.businessId)); });

exports.createGroup = catchAsync(async (req, res) => { const group = await svc.createGroup(req.businessId, req.user, req.body, meta(req)); sendSuccess(res, 201, 'Group created', { group }); });
exports.updateGroup = catchAsync(async (req, res) => ok(res, 'Group updated', { group: await svc.updateGroup(req.businessId, req.user, req.params.groupId, req.body, meta(req)) }));
exports.deleteGroup = catchAsync(async (req, res) => ok(res, 'Group deleted', await svc.deleteGroup(req.businessId, req.user, req.params.groupId, meta(req))));

exports.listEmployees = catchAsync(async (req, res) => ok(res, 'Employees', await svc.listEmployees(req.businessId)));
exports.getEmployee = catchAsync(async (req, res) => ok(res, 'Employee access', await svc.getEmployeeAccess(req.businessId, req.params.id)));
exports.updateEmployee = catchAsync(async (req, res) => ok(res, 'Access updated', await svc.updateEmployee(req.businessId, req.user, req.params.id, req.body, meta(req))));
exports.bulk = catchAsync(async (req, res) => ok(res, 'Bulk update done', await svc.bulkUpdate(req.businessId, req.user, req.body, meta(req))));
