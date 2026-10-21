const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const ss = require('../services/restaurant/selfservice.service');

const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (req) => req.businessId; const u = (req) => req.user;
const p = (r) => r.params;

module.exports = {
  // ---- public kiosk (token only)
  context: h(200, 'OK', async (r) => ss.context(p(r).token)),
  tables: h(200, 'OK', async (r) => ss.tables(p(r).token)),
  menu: h(200, 'OK', async (r) => ss.menu(p(r).token, r.query)),
  quote: h(200, 'OK', async (r) => ss.quote(p(r).token, r.body)),
  createOrder: h(201, 'Order created', async (r) => ss.createOrder(p(r).token, r.body)),
  status: h(200, 'OK', async (r) => ss.status(p(r).token, p(r).code)),
  payMpesa: h(200, 'Payment request sent', async (r) => ss.payMpesa(p(r).token, p(r).code, r.body)),
  payCash: h(200, 'Bill ready', async (r) => ss.payCash(p(r).token, p(r).code)),
  cancel: h(200, 'Order cancelled', async (r) => ss.cancelByCustomer(p(r).token, p(r).code)),
  bill: h(200, 'OK', async (r) => ss.billDoc(p(r).token, p(r).code)),
  print: h(200, 'Sent to the printer queue', async (r) => ss.queuePrint(p(r).token, p(r).code)),

  // ---- staff (authenticated; identity always comes from the login, never the body)
  link: h(200, 'OK', async (r) => ss.kioskLink(b(r), u(r), r.query)),
  rotateLink: h(200, 'Kiosk link replaced', async (r) => ss.rotateKiosk(b(r), u(r))),
  staffList: h(200, 'OK', async (r) => ss.staffList(b(r), u(r), r.query)),
  confirmCash: h(200, 'Cash confirmed', async (r) => ss.confirmCash(b(r), u(r), r.params.id, r.body)),
  staffReprint: h(200, 'Sent to the printer queue', async (r) => ss.staffReprint(b(r), u(r), r.params.id)),
};
