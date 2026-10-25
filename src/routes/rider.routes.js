/**
 * RIDER APP API. Mounted at /api/v1/rider. Sign in through the rider QR page (POST /api/v1/public/rider/:token/login), then:
 *   Authorization: Bearer <accessToken>   (refresh with the normal /auth/refresh)
 * Live: POST /stream-ticket -> GET /stream?ticket=...  (Server-Sent Events). Location: POST /location every ~5 s while on duty.
 */
const router = require('express').Router();
const c = require('../controllers/rider.controller');
const v = require('../validators/rider.validator');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission: P } = require('../middleware/auth');

// the live stream authenticates with its own short ticket (an EventSource cannot send headers)
router.get('/stream', validate({ query: v.streamQuery }), c.riderStream);

router.use(authenticate, requireFeature('restaurantOrdering'), P('restaurant.delivery.self'));
const id = { params: v.idParam };

router.get('/dashboard', c.dashboard);
router.get('/me', c.me);
router.get('/deliveries', validate({ query: v.listQuery }), c.list);
router.get('/deliveries/:id', validate(id), c.detail);
router.post('/deliveries/:id/pickup', validate(id), c.pickup);
router.post('/deliveries/:id/start', validate({ ...id, body: v.here }), c.start);
router.post('/deliveries/:id/arrived', validate({ ...id, body: v.here }), c.arrived);
router.post('/deliveries/:id/complete', validate(id), c.complete);
router.post('/deliveries/:id/fail', validate({ ...id, body: v.failBody }), c.fail);
router.get('/available', c.available);
router.post('/deliveries/:id/claim', validate(id), c.claim);
router.get('/earnings', validate({ query: v.earningsQuery }), c.earnings);

router.post('/online', validate({ body: v.online }), c.setOnline);
router.post('/location', validate({ body: v.location }), c.location);

router.get('/deliveries/:id/payment', validate(id), c.paymentSummary);
router.post('/deliveries/:id/payment/mpesa', validate({ ...id, body: v.mpesaBody }), c.payMpesa);
router.get('/payments/mpesa/:reference', validate({ params: v.referenceParam }), c.mpesaStatus);
router.post('/deliveries/:id/payment/cash', validate({ ...id, body: v.cashBody }), c.payCash);
router.post('/cash/returning', c.returning);
router.get('/wallet', c.wallet);

router.get('/push/key', c.pushKey);
router.post('/push/subscribe', validate({ body: v.pushBody }), c.pushSubscribe);
router.post('/push/unsubscribe', validate({ body: v.pushBody.pick({ endpoint: true }) }), c.pushUnsubscribe);
router.post('/stream-ticket', c.ticket('rider'));

module.exports = router;
