/**
 * STAFF side of delivery: live map board, one delivery in detail, rider cash at the till, rider QR. Mounted at /api/v1/delivery-live.
 * (Assigning a rider and changing status stay on /api/v1/restaurant/orders/:id/delivery/*.)
 */
const router = require('express').Router();
const c = require('../controllers/rider.controller');
const v = require('../validators/rider.validator');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const requireAddon = require('../middleware/requireAddon');
const { authenticate, requirePermission: P } = require('../middleware/auth');

router.get('/stream', validate({ query: v.streamQuery }), c.staffStream);       // ticket-authenticated

router.use(authenticate, requireFeature('restaurantOrdering'), requireAddon('livetracking')); // premium add-on
router.post('/stream-ticket', P('restaurant.delivery.view'), c.ticket('staff'));
router.get('/board', P('restaurant.delivery.view'), validate({ query: v.branchQuery }), c.board);
router.get('/orders/:id', P('restaurant.delivery.view'), validate({ params: v.idParam }), c.orderTrack);

router.get('/cash', P('restaurant.delivery.cash'), validate({ query: v.branchQuery }), c.cashHeld);
router.post('/cash/handover', P('restaurant.delivery.cash'), validate({ body: v.handoverBody }), c.handover);
router.get('/cash/history', P('restaurant.delivery.cash'), validate({ query: v.historyQuery }), c.handoverHistory);

router.get('/qr', P('restaurant.delivery.qr'), c.riderQr);
router.post('/qr/rotate', P('restaurant.delivery.qr'), c.riderQrRotate);

router.get('/push/key', P('restaurant.delivery.view'), c.pushKey);
router.post('/push/subscribe', P('restaurant.delivery.view'), validate({ body: v.pushBody }), c.pushSubscribe);

module.exports = router;
