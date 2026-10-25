/**
 * PUBLIC TV API, mounted at /api/v1/public/tv. No staff login: a TV pairs once with an 8-character code and then holds its own
 * revocable device token (header X-TV-Token, or ?token= for the EventSource stream). It can only read its own published menu.
 */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const v = require('../validators/tv.validator');
const svc = require('../services/tv/tv.service');

const msg = { success: false, message: 'Too many requests. Please wait a moment.', code: 'RATE_LIMITED' };
const pairLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: msg });
const tokenOf = (r) => r.headers['x-tv-token'] || r.query.token;
const dev = rateLimit({ windowMs: 60 * 1000, max: 40, keyGenerator: (r) => String(tokenOf(r) || r.ip).slice(0, 60), standardHeaders: true, legacyHeaders: false, message: msg });
const meta = (r) => ({ ip: r.ip, ua: r.headers['user-agent'], shownVersion: r.body && r.body.shownVersion != null ? r.body.shownVersion : r.query.v != null ? Number(r.query.v) : undefined, appVersion: r.body && r.body.appVersion });
const noStore = (res) => res.set('Cache-Control', 'no-store');

router.post('/pair', pairLimit, validate({ body: v.pairBody }), catchAsync(async (req, res) => { noStore(res); sendSuccess(res, 200, 'Screen paired', await svc.pair(req.body.code, meta(req))); }));
router.get('/content', dev, catchAsync(async (req, res) => { noStore(res); const s = await svc.authDevice(tokenOf(req)); sendSuccess(res, 200, 'OK', await svc.content(s, meta(req), req.query.etag)); }));
router.post('/heartbeat', dev, validate({ body: v.beat }), catchAsync(async (req, res) => { noStore(res); const s = await svc.authDevice(tokenOf(req)); sendSuccess(res, 200, 'OK', await svc.heartbeat(s, meta(req))); }));
router.post('/error', dev, validate({ body: v.errBody }), catchAsync(async (req, res) => { const s = await svc.authDevice(tokenOf(req)); sendSuccess(res, 200, 'OK', await svc.reportError(s, req.body.message)); }));
router.get('/stream', catchAsync(async (req, res) => { const s = await svc.authDevice(tokenOf(req)); await svc.heartbeat(s, meta(req)); svc.stream(s, req, res); }));
module.exports = router;
