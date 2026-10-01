const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const announcements = require('../services/announcement.service');

/** GET /announcements/active?page=dashboard - what THIS user should see on that page. */
exports.active = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Announcements fetched', await announcements.listActive(req.user, req.query.page)));