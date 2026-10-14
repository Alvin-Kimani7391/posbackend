const router = require('express').Router();
const c = require('../controllers/garage.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/garage.validator');

router.use(authenticate, requireFeature('jobCards', 'vehicleManagement'));

router.get('/', requirePermission('jobcards.view'), validate({ query: v.jobCardListQuery }), c.listJobCards);
router.get('/summary', requirePermission('reports.view'), validate({ query: v.summaryQuery }), c.jobCardSummary);
router.get('/uncollected', requirePermission('jobcards.view'), validate({ query: v.uncollectedQuery }), c.uncollected);
router.post('/', requirePermission('jobcards.manage'), requireBranchAccess, validate({ body: v.createJobCardSchema }), c.createJobCard);
router.get('/:id', requirePermission('jobcards.view'), validate({ params: v.idParamSchema }), c.getJobCard);

router.put('/:id/estimate', requirePermission('jobcards.manage'), validate({ params: v.idParamSchema, body: v.estimateSchema }), c.estimate);
router.post('/:id/approval', requirePermission('jobcards.manage'), validate({ params: v.idParamSchema, body: v.approvalSchema }), c.approval);
router.post('/:id/parts/:partId/issue', requirePermission('jobcards.manage'), validate({ params: v.partParamSchema }), c.issuePart);
router.post('/:id/parts/:partId/return', requirePermission('jobcards.manage'), validate({ params: v.partParamSchema }), c.returnPart);
router.post('/:id/labour/:labourId/done', requirePermission('jobcards.work'), validate({ params: v.labourParamSchema, body: v.labourDoneSchema }), c.labourDone);
router.post('/:id/action', requirePermission('jobcards.work'), validate({ params: v.idParamSchema, body: v.actionSchema }), c.action);
router.post('/:id/quality-check', requirePermission('jobcards.work'), validate({ params: v.idParamSchema, body: v.qcSchema }), c.qualityCheck);
router.post('/:id/payments', requirePermission('jobcards.manage'), validate({ params: v.idParamSchema, body: v.paymentSchema }), c.payment);
router.post('/:id/notify', requirePermission('jobcards.manage'), validate({ params: v.idParamSchema }), c.notifyReady);
router.post('/:id/collect', requirePermission('jobcards.manage'), validate({ params: v.idParamSchema, body: v.collectSchema }), c.collect);
router.post('/:id/cancel', requirePermission('jobcards.manage'), validate({ params: v.idParamSchema, body: v.cancelSchema }), c.cancelJobCard);

module.exports = router;