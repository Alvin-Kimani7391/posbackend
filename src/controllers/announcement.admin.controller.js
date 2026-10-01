const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const announcements = require('../services/announcement.service');

exports.list = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Announcements fetched', await announcements.adminList(req.query)));

exports.get = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Announcement fetched', { announcement: await announcements.adminGet(req.params.id) }));

exports.create = catchAsync(async (req, res) =>
  sendSuccess(res, 201, 'Announcement created', { announcement: await announcements.adminCreate(req.user, req.body) }));

exports.update = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Announcement updated', { announcement: await announcements.adminUpdate(req.user, req.params.id, req.body) }));

exports.setActive = catchAsync(async (req, res) =>
  sendSuccess(
    res, 200, req.body.isActive ? 'Announcement resumed' : 'Announcement paused',
    { announcement: await announcements.adminSetActive(req.user, req.params.id, req.body.isActive) }
  ));

exports.remove = catchAsync(async (req, res) => {
  await announcements.adminRemove(req.user, req.params.id);
  return sendSuccess(res, 200, 'Announcement deleted', {});
});