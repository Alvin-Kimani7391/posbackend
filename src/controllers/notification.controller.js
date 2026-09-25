const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const notificationService = require('../services/notification.service');

exports.list = catchAsync(async (req, res) => {
  const result = await notificationService.listForUser(req.businessId, req.user._id, req.query);
  return sendSuccess(res, 200, 'Notifications fetched', result);
});

exports.markRead = catchAsync(async (req, res) => {
  const notification = await notificationService.markRead(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Notification marked as read', { notification });
});

exports.markAllRead = catchAsync(async (req, res) => {
  const result = await notificationService.markAllRead(req.businessId, req.user._id);
  return sendSuccess(res, 200, 'All notifications marked as read', result);
});

exports.remove = catchAsync(async (req, res) => {
  await notificationService.remove(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Notification deleted', {});
});

/** Employee-raised alert: any staff member notifies OWNER/ADMIN/MANAGER about something. */
exports.raiseAlert = catchAsync(async (req, res) => {
  const branchId = req.body.branchId || req.user.branchIds?.[0];
  const notifications = await notificationService.notifyEmployeeAlert(req.businessId, branchId, req.user, req.body);
  return sendSuccess(res, 201, 'Alert sent to management', { notifications });
});