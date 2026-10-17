const router = require('express').Router();
const c = require('../controllers/layaway.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/layaway.validator');

router.use(authenticate, requireFeature('layaway'));

router.get('/', requirePermission('layaways.view'), validate({ query: v.layawayListQuery }), c.list);
router.get('/summary', requirePermission('reports.view'), validate({ query: v.summaryQuery }), c.summary);
router.post('/', requirePermission('layaways.manage'), requireBranchAccess, validate({ body: v.createLayawaySchema }), c.create);
router.get('/:id', requirePermission('layaways.view'), validate({ params: v.idParamSchema }), c.get);
router.post('/:id/payments', requirePermission('layaways.manage'), validate({ params: v.idParamSchema, body: v.layawayPaymentSchema }), c.pay);
router.post('/:id/collect', requirePermission('layaways.manage'), validate({ params: v.idParamSchema, body: v.collectSchema }), c.collect);
router.post('/:id/extend', requirePermission('layaways.approve'), validate({ params: v.idParamSchema, body: v.extendSchema }), c.extend);
router.post('/:id/cancel', requirePermission('layaways.approve'), validate({ params: v.idParamSchema, body: v.cancelSchema }), c.cancel);

module.exports = router;