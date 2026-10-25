/** PUBLIC rider entry. Mounted at /api/v1/public/rider. The signed QR token identifies the business; only a user with the DELIVERY_RIDER role can sign in. */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const c = require('../controllers/rider.controller');
const v = require('../validators/rider.validator');
const validate = require('../middleware/validate');

const lim = (windowMs, max) => rateLimit({ windowMs, max, keyGenerator: (req) => `${String(req.params.token || '').slice(0, 40)}:${req.ip}`, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many attempts. Please wait a few minutes.', code: 'RATE_LIMITED' } });
const tok = { params: z.object({ token: z.string().max(120) }) };

router.get('/:token', lim(60000, 60), validate(tok), c.qrContext);
router.post('/:token/login', lim(15 * 60000, 20), validate({ ...tok, body: v.loginBody }), c.qrLogin);

module.exports = router;
