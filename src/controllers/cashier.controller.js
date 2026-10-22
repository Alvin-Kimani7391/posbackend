const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const cashier = require('../services/cashier/cashier.service');

const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (req) => req.businessId; const u = (req) => req.user;

module.exports = {
  overview: h(200, 'Cashier overview fetched', async (r) => cashier.overview(b(r), u(r), r.query)),
  queue: h(200, 'Payment queue fetched', async (r) => cashier.queue(b(r), u(r), r.query)),
  orderDetail: h(200, 'Order details fetched', async (r) => cashier.orderDetail(b(r), u(r), r.params.id)),
  payments: h(200, 'Payments fetched', async (r) => cashier.payments(b(r), u(r), r.query)),
  drawer: h(200, 'Cash drawer fetched', async (r) => cashier.drawer(b(r), u(r), r.query)),
  drawerEvent: h(201, 'Drawer action recorded', async (r) => cashier.recordDrawerEvent(b(r), u(r), r.body)),
  reprint: h(200, 'Receipt sent to the cashier printer', async (r) => cashier.reprintReceipt(b(r), u(r), r.params.id)),
};
