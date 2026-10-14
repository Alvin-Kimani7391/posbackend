const router = require('express').Router();
const c = require('../controllers/electronics.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/electronics.validator');

router.use(authenticate, requireFeature('repairManagement'));

router.get('/', requirePermission('repairs.view'), validate({ query: v.repairListQuery }), c.listRepairs);
router.get('/summary', requirePermission('reports.view'), validate({ query: v.repairSummaryQuery }), c.repairSummary);
router.get('/uncollected', requirePermission('repairs.view'), validate({ query: v.uncollectedQuery }), c.uncollected);
router.post('/', requirePermission('repairs.manage'), requireBranchAccess, validate({ body: v.createRepairSchema }), c.createRepair);
router.get('/:id', requirePermission('repairs.view'), validate({ params: v.idParamSchema }), c.getRepair);

router.put('/:id/estimate', requirePermission('repairs.manage'), validate({ params: v.idParamSchema, body: v.estimateSchema }), c.estimate);
router.post('/:id/approval', requirePermission('repairs.manage'), validate({ params: v.idParamSchema, body: v.approvalSchema }), c.approval);
router.post('/:id/parts/:partId/issue', requirePermission('repairs.manage'), validate({ params: v.partParamSchema }), c.issuePart);
router.post('/:id/parts/:partId/return', requirePermission('repairs.manage'), validate({ params: v.partParamSchema }), c.returnPart);
router.post('/:id/action', requirePermission('repairs.manage'), validate({ params: v.idParamSchema, body: v.actionSchema }), c.action);
router.post('/:id/payments', requirePermission('repairs.manage'), validate({ params: v.idParamSchema, body: v.repairPaymentSchema }), c.payment);
router.post('/:id/notify', requirePermission('repairs.manage'), validate({ params: v.idParamSchema }), c.notifyReady);
router.post('/:id/collect', requirePermission('repairs.manage'), validate({ params: v.idParamSchema, body: v.collectSchema }), c.collect);
router.post('/:id/cancel', requirePermission('repairs.manage'), validate({ params: v.idParamSchema, body: v.cancelRepairSchema }), c.cancelRepair);

module.exports = router;