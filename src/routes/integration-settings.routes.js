const router = require('express').Router();
const controller = require('../controllers/integration-settings.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { updateMpesaSchema, updateEtimsSchema } = require('../validators/integration-settings.validator');

router.use(authenticate);

router.get('/', requirePermission('settings.view'), controller.getStatus);
router.get('/flags', requirePermission('payments.view'), controller.getFlags); // cashiers - just booleans

router.put('/mpesa', requirePermission('settings.update'), validate({ body: updateMpesaSchema }), controller.updateMpesa);
router.put('/etims', requirePermission('settings.update'), validate({ body: updateEtimsSchema }), controller.updateEtims);

router.post('/mpesa/test', requirePermission('settings.update'), controller.testMpesa);
router.post('/etims/test', requirePermission('settings.update'), controller.testEtims);

module.exports = router;