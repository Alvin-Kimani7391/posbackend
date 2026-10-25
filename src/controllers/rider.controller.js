/** Rider app, staff live board and cash handover. Thin: every rule lives in services/delivery. */
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const rider = require('../services/delivery/rider.service');
const tracking = require('../services/delivery/tracking.service');
const payments = require('../services/delivery/delivery-payment.service');
const access = require('../services/delivery/rider-access.service');
const stream = require('../services/delivery/stream.service');
const push = require('../services/delivery/push.service');
const authService = require('../services/auth.service');
const businessService = require('../services/business.service');

const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (r) => r.businessId; const u = (r) => r.user;
const meta = (r) => ({ ip: r.ip, userAgent: r.headers['user-agent'] });
const pushOwner = (r) => ({ audience: 'STAFF', userId: u(r)._id });

module.exports = {
  // ---- public: the rider QR page
  qrContext: h(200, 'OK', async (r) => access.publicContext(r.params.token)),
  qrLogin: h(200, 'Login successful', async (r) => {
    const out = await access.login(r.params.token, r.body, meta(r));
    const country = await businessService.getCountrySummary(out.user.businessId).catch(() => null);
    return { user: out.user.toSafeJSON ? out.user.toSafeJSON() : out.user, country, accessToken: out.accessToken, refreshToken: out.refreshToken };
  }),

  // ---- rider app
  dashboard: h(200, 'Dashboard fetched', async (r) => rider.dashboard(b(r), u(r))),
  me: h(200, 'Profile fetched', async (r) => rider.me(b(r), u(r))),
  list: h(200, 'Deliveries fetched', async (r) => rider.list(b(r), u(r), r.query)),
  detail: h(200, 'Delivery fetched', async (r) => rider.detail(b(r), u(r), r.params.id)),
  pickup: h(200, 'Picked up', async (r) => rider.pickup(b(r), u(r), r.params.id)),
  start: h(200, 'Delivery started', async (r) => rider.start(b(r), u(r), r.params.id, r.body)),
  arrived: h(200, 'Arrived', async (r) => rider.arrived(b(r), u(r), r.params.id, r.body)),
  complete: h(200, 'Delivered', async (r) => rider.complete(b(r), u(r), r.params.id)),
  fail: h(200, 'Delivery updated', async (r) => rider.fail(b(r), u(r), r.params.id, r.body)),
  available: h(200, 'Available deliveries fetched', async (r) => rider.available(b(r), u(r))),
  claim: h(200, 'Delivery claimed', async (r) => rider.claim(b(r), u(r), r.params.id)),
  earnings: h(200, 'Earnings fetched', async (r) => rider.earnings(b(r), u(r), r.query)),
  setOnline: h(200, 'Status updated', async (r) => ({ presence: await tracking.setOnline(b(r), u(r), r.body.online, r.body) })),
  location: h(200, 'OK', async (r) => tracking.ingest(b(r), u(r), r.body)),

  // ---- rider payments
  paymentSummary: h(200, 'Payment fetched', async (r) => payments.summary(b(r), u(r), r.params.id)),
  payMpesa: h(200, 'M-PESA request sent to the customer', async (r) => payments.startMpesa(b(r), u(r), r.params.id, r.body)),
  mpesaStatus: h(200, 'Payment status fetched', async (r) => payments.mpesaStatus(b(r), u(r), r.params.reference)),
  payCash: h(200, 'Cash recorded', async (r) => payments.collectCash(b(r), u(r), r.params.id, r.body)),
  returning: h(200, 'The cashier has been told', async (r) => payments.returning(b(r), u(r))),
  wallet: h(200, 'Wallet fetched', async (r) => payments.wallet(b(r), u(r))),

  // ---- push + live stream (rider and staff share these)
  pushKey: h(200, 'OK', async () => ({ enabled: push.enabled(), publicKey: push.publicKey() })),
  pushSubscribe: h(200, 'Notifications on', async (r) => push.subscribe(b(r), pushOwner(r), r.body, { userAgent: r.headers['user-agent'] })),
  pushUnsubscribe: h(200, 'Notifications off', async (r) => { await push.unsubscribe(r.body.endpoint); return { ok: true }; }),
  ticket: (scope) => h(200, 'OK', async (r) => stream.issueTicket(u(r), scope)),
  riderStream: catchAsync(async (req, res) => stream.riderStream(req, res)),
  staffStream: catchAsync(async (req, res) => stream.staffStream(req, res)),

  // ---- staff: live board, one delivery, cash at the till, QR
  board: h(200, 'Live board fetched', async (r) => tracking.liveBoard(b(r), u(r), r.query)),
  orderTrack: h(200, 'Delivery fetched', async (r) => tracking.orderTrack(b(r), u(r), r.params.id)),
  cashHeld: h(200, 'Rider cash fetched', async (r) => payments.heldByRider(b(r), u(r), r.query)),
  handover: h(200, 'Cash received', async (r) => payments.handover(b(r), u(r), r.body)),
  handoverHistory: h(200, 'Handovers fetched', async (r) => payments.handoverHistory(b(r), u(r), r.query)),
  riderQr: h(200, 'Rider QR fetched', async (r) => access.riderQr(b(r), u(r))),
  riderQrRotate: h(200, 'Rider QR replaced', async (r) => access.rotateRiderQr(b(r), u(r))),
};
