const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const auditLogService = require('../services/auditlog.service');

exports.list = catchAsync(async (req, res) => {
  const result = await auditLogService.listAuditLogs(req.businessId, req.query);
  return sendSuccess(res, 200, 'Audit logs fetched', result);
});