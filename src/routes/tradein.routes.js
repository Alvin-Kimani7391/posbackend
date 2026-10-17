const router = require('express').Router();
const c = require('../controllers/layaway.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/layaway.validator');

router.use(authenticate, requireFeature('tradeIn'));

router.get('/', requirePermission('tradeins.view'), validate({ query: v.tradeInListQuery }), c.listTradeIns);
router.post('/', requirePermission('tradeins.manage'), requireBranchAccess, validate({ body: v.appraiseSchema }), c.appraise);
router.get('/:id', requirePermission('tradeins.view'), validate({ params: v.idParamSchema }), c.getTradeIn);
router.post('/:id/approve', requirePermission('tradeins.approve'), validate({ params: v.idParamSchema }), c.approveTradeIn);
router.post('/:id/accept', requirePermission('tradeins.manage'), validate({ params: v.idParamSchema, body: v.acceptSchema }), c.acceptTradeIn);
router.post('/:id/cancel', requirePermission('tradeins.manage'), validate({ params: v.idParamSchema, body: v.cancelTradeInSchema }), c.cancelTradeIn);

module.exports = router;