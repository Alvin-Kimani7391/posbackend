const router = require('express').Router();
const controller = require('../controllers/batch.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const v = require('../validators/batch.validator');

router.use(authenticate);

router.get('/', requirePermission('batches.view'), validate({ query: v.listBatchesQuery }), controller.list);
router.get('/expiring', requirePermission('batches.view'), validate({ query: v.expiringQuery }), controller.expiring);
router.get('/:id/sales', requirePermission('batches.view'), validate({ params: v.idParamSchema }), controller.trace);

router.post('/recall', requirePermission('batches.manage'), validate({ body: v.recallBody }), controller.recall);
router.post('/:id/quarantine', requirePermission('batches.manage'), validate({ params: v.idParamSchema, body: v.quarantineBody }), controller.quarantine);
router.post('/:id/release', requirePermission('batches.manage'), validate({ params: v.idParamSchema, body: v.releaseBody }), controller.release);
router.post('/:id/dispose', requirePermission('batches.manage'), validate({ params: v.idParamSchema, body: v.disposeBody }), controller.dispose);

module.exports = router;