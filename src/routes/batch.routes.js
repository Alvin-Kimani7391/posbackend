const router = require('express').Router();
const controller = require('../controllers/batch.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const v = require('../validators/batch.validator');

router.use(authenticate);

router.get('/', requirePermission('batches.view'), validate({ query: v.listBatchesQuery }), controller.list);
router.get('/expiring', requirePermission('batches.view'), validate({ query: v.expiringQuery }), controller.expiring);
router.get('/available', requirePermission('batches.view'), validate({ query: v.availableQuery }), controller.available);
router.get('/alert-settings', requirePermission('batches.view'), controller.getAlertSettings);
router.put('/alert-settings', requirePermission('batches.manage'), validate({ body: v.alertSettingsBody }), controller.updateAlertSettings);
router.post('/alerts/run', requirePermission('batches.manage'), controller.runAlertsNow);
router.get('/unbatched', requirePermission('batches.view'), validate({ query: v.unbatchedQuery }), controller.unbatched);
router.get('/:id/sales', requirePermission('batches.view'), validate({ params: v.idParamSchema }), controller.trace);

router.post('/backfill', requirePermission('batches.manage'), validate({ body: v.backfillBody }), controller.backfill);
router.post('/recall', requirePermission('batches.manage'), validate({ body: v.recallBody }), controller.recall);
router.post('/:id/quarantine', requirePermission('batches.manage'), validate({ params: v.idParamSchema, body: v.quarantineBody }), controller.quarantine);
router.post('/:id/release', requirePermission('batches.manage'), validate({ params: v.idParamSchema, body: v.releaseBody }), controller.release);
router.post('/:id/dispose', requirePermission('batches.manage'), validate({ params: v.idParamSchema, body: v.disposeBody }), controller.dispose);

module.exports = router;