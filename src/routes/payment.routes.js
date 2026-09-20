const router = require('express').Router();
const controller = require('../controllers/payment.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { listPaymentsQuery, idParamSchema } = require('../validators/payment.validator');

router.use(authenticate);

router.get('/', requirePermission('payments.view'), validate({ query: listPaymentsQuery }), controller.list);
router.get('/:id', requirePermission('payments.view'), validate({ params: idParamSchema }), controller.getOne);

module.exports = router;
