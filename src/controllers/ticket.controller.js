const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const tickets = require('../services/ticket.service');

exports.create = catchAsync(async (req, res) => {
  const ticket = await tickets.createTicket(
    req.businessId, req.user,
    { ...req.body, userAgent: req.headers['user-agent'] },
    req.files
  );
  return sendSuccess(res, 201, 'Ticket raised - support has been notified', { ticket });
});

exports.list = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Tickets fetched', await tickets.listTickets(req.businessId, req.user, req.query)));

exports.get = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Ticket fetched', { ticket: await tickets.getTicket(req.businessId, req.user, req.params.id) }));

exports.reply = catchAsync(async (req, res) =>
  sendSuccess(res, 201, 'Reply sent', { ticket: await tickets.addReply(req.businessId, req.user, req.params.id, req.body.message, req.files) }));

exports.close = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Ticket closed', { ticket: await tickets.closeOwn(req.businessId, req.user, req.params.id) }));
