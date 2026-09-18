const router = require('express').Router();
const controller = require('../controllers/business.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { updateBusinessSchema } = require('../validators/business.validator');

router.use(authenticate);

router.get('/', requirePermission('settings.view'), controller.getBusiness);
router.put('/', requirePermission('settings.update'), validate({ body: updateBusinessSchema }), controller.updateBusiness);

module.exports = router;
