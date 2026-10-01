const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const tickets = require('../services/ticket.service');

exports.list = catchAsync(async (req, res) => sendSuccess(res, 200, 'Tickets fetched', await tickets.adminList(req.query)));
exports.stats = catchAsync(async (req, res) => sendSuccess(res, 200, 'Ticket stats fetched', await tickets.adminStats()));
exports.get = catchAsync(async (req, res) => sendSuccess(res, 200, 'Ticket fetched', { ticket: await tickets.adminGet(req.params.id) }));
exports.reply = catchAsync(async (req, res) =>
  sendSuccess(res, 201, 'Reply sent', { ticket: await tickets.adminReply(req.user, req.params.id, req.body.message, req.files) }));
exports.update = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Ticket updated', { ticket: await tickets.adminUpdate(req.user, req.params.id, req.body) }));
