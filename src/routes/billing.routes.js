const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/billing.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const v = require('../validators/billing.validator');

const callbackLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const payLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// PUBLIC (PayHero) - declared before authenticate. Protected by the per-payment secret in the URL.
router.post('/callback/:paymentId/:token', callbackLimiter, controller.callback);

router.use(authenticate);

// Any logged-in user (shows the lock screen / banner). Amounts are only included for users who may see billing.
router.get('/status', controller.status);

router.get('/overview', requirePermission('billing.view'), controller.overview);
router.get('/invoices', requirePermission('billing.view'), validate({ query: v.listQuery }), controller.invoices);
router.get('/payments', requirePermission('billing.view'), validate({ query: v.listQuery }), controller.payments);
router.get('/payments/:id/status', requirePermission('billing.view'), validate({ params: v.idParamSchema }), controller.paymentStatus);

router.post('/payments/stk', requirePermission('billing.pay'), payLimiter, validate({ body: v.stkSchema }), controller.stk);
router.post('/payments/manual', requirePermission('billing.pay'), payLimiter, validate({ body: v.manualSchema }), controller.manual);

module.exports = router;