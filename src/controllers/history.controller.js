const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const history = require('../services/restaurant/history.service');

const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (req) => req.businessId; const u = (req) => req.user;

module.exports = {
  orders: h(200, 'Orders fetched', async (r) => history.orders(b(r), u(r), r.query, 'orders')),
  reportOrders: h(200, 'Orders fetched', async (r) => history.orders(b(r), u(r), r.query, 'report')),
  deliveries: h(200, 'Delivery history fetched', async (r) => history.deliveries(b(r), u(r), r.query)),
  guest: h(200, 'Guest history fetched', async (r) => history.guest(b(r), u(r), r.query)),
};
