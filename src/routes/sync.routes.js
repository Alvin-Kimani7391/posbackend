const router = require('express').Router();
const controller = require('../controllers/sync.controller');
const validate = require('../middleware/validate');
const { syncLimiter } = require('../middleware/rateLimiters');
const { authenticate, requirePermission } = require('../middleware/auth');
const { pushSchema, deviceQuery, catalogQuery } = require('../validators/sync.validator');

router.use(authenticate);
router.use(requirePermission('sales.create'));

router.post('/push', syncLimiter, validate({ body: pushSchema }), controller.push);
router.get('/context', validate({ query: deviceQuery }), controller.context);
router.get('/catalog/ids', validate({ query: deviceQuery }), controller.catalogIds);
router.get('/catalog', validate({ query: catalogQuery }), controller.catalog);

module.exports = router;