/**
 * PUBLIC self-service kiosk API. Mounted at /api/v1/public/kiosk. NO LOGIN: the signed kiosk token in the URL identifies one business
 * (see selfservice.service); the branch, prices, totals, payment state and every on/off switch come from the SERVER, never the browser.
 * Rate limits are per token + IP so one busy kiosk cannot lock out another.
 */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const c = require('../controllers/selfservice.controller');
const validate = require('../middleware/validate');
const v = require('../validators/selfservice.validator');

const key = (req) => `${req.params.token || ''}:${req.ip}`;
const lim = (windowMs, max) => rateLimit({ windowMs, max, keyGenerator: key, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests. Please wait a moment.', code: 'RATE_LIMITED' } });
const read = lim(60 * 1000, 120);
const write = lim(60 * 1000, 20);
const poll = lim(60 * 1000, 60);
const tok = { params: v.tokenParam };
const cod = { params: v.codeParam };

router.get('/:token', read, validate(tok), c.context);
router.get('/:token/tables', read, validate(tok), c.tables);
router.get('/:token/menu', read, validate({ ...tok, query: v.menuQuery }), c.menu);
router.post('/:token/quote', write, validate({ ...tok, body: v.quoteBody }), c.quote);
router.post('/:token/orders', write, validate({ ...tok, body: v.orderBody }), c.createOrder);
router.get('/:token/orders/:code', poll, validate(cod), c.status);
router.post('/:token/orders/:code/mpesa', write, validate({ ...cod, body: v.mpesaBody }), c.payMpesa);
router.post('/:token/orders/:code/cash', write, validate(cod), c.payCash);
router.post('/:token/orders/:code/cancel', write, validate(cod), c.cancel);
router.get('/:token/orders/:code/bill', poll, validate(cod), c.bill);
router.post('/:token/orders/:code/print', write, validate(cod), c.print);

module.exports = router;
