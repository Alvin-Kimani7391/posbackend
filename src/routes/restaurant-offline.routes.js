/**
 * Offline support for restaurant + accommodation tills. Mounted at /api/v1/restaurant/offline (inherits authenticate + the
 * restaurantOrdering feature gate). Every replayed step is re-checked by the same service (and permission) the online app uses.
 */
const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const validate = require('../middleware/validate');
const { syncLimiter } = require('../middleware/rateLimiters');
const { requirePermission: P } = require('../middleware/auth');
const v = require('../validators/restaurant-offline.validator');
const svc = require('../services/restaurant/offline.service');

const h = (status, message, fn) => catchAsync(async (req, res) => { res.set('Cache-Control', 'no-store'); return sendSuccess(res, status, message, await fn(req)); });

router.get('/snapshot', validate({ query: v.snapshotQuery }), h(200, 'Offline snapshot fetched', (r) => svc.snapshot(r.businessId, r.user, r.query)));
router.post('/replay', syncLimiter, validate({ body: v.replayBody }), h(200, 'Offline steps processed', (r) => svc.replay(r.businessId, r.user, r.body)));
router.get('/ops', P('offline.review'), validate({ query: v.opsQuery }), h(200, 'Offline steps fetched', (r) => svc.listOps(r.businessId, r.user, r.query)));
router.post('/ops/:id/review', P('offline.review'), validate({ params: v.idParam }), h(200, 'Marked as reviewed', async (r) => ({ op: await svc.reviewOp(r.businessId, r.user, r.params.id) })));
router.post('/ops/:id/retry', P('offline.review'), validate({ params: v.idParam }), h(200, 'Step retried', (r) => svc.retryOp(r.businessId, r.user, r.params.id)));

module.exports = router;
