/** OWNER side, mounted by billing.routes.js at /api/v1/billing/addons (behind authenticate). */
const router = require('express').Router();
const c = require('../controllers/addon.controller');
const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const v = require('../validators/addon.validator');
router.get('/', c.list); // any signed-in user (menu needs it for crown icons)
router.post('/:key/subscribe', requirePermission('billing.pay'), validate({ params: v.keyParam }), c.subscribe);
router.post('/:key/cancel', requirePermission('billing.pay'), validate({ params: v.keyParam, body: v.cancelBody }), c.cancel);
router.post('/:key/resume', requirePermission('billing.pay'), validate({ params: v.keyParam }), c.resume);
module.exports = router;
