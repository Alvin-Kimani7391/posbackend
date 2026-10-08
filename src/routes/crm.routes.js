const router = require('express').Router();
const controller = require('../controllers/crm.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const v = require('../validators/crm.validator');

router.use(authenticate);

// Spending data is sensitive: same gate as Reports.
const view = requirePermission('reports.view');
const manage = requirePermission('customers.update');
const admin = requirePermission('settings.update');

router.get('/overview', view, controller.overview);

router.get('/customers', view, validate({ query: v.listCustomersQuery }), controller.listCustomers);
router.get('/customers/:id', view, validate({ params: v.idParam }), controller.getProfile);
router.put('/customers/:id/tags', manage, validate({ params: v.idParam, body: v.tagsSchema }), controller.updateTags);

router.get('/segments', view, controller.listSegments);
router.post('/segments/preview', view, validate({ body: v.previewSchema }), controller.previewSegment); // before /:id
router.post('/segments', manage, validate({ body: v.segmentSchema }), controller.createSegment);
router.put('/segments/:id', manage, validate({ params: v.segmentIdParam, body: v.segmentSchema }), controller.updateSegment);
router.delete('/segments/:id', manage, validate({ params: v.segmentIdParam }), controller.deleteSegment);

router.get('/settings', view, controller.getSettings);
router.put('/settings', admin, validate({ body: v.settingsSchema }), controller.updateSettings);
router.get('/rebuild', admin, controller.rebuildStatus);
router.post('/rebuild', admin, controller.startRebuild);

module.exports = router;