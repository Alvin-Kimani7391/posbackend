const router = require('express').Router();
const controller = require('../controllers/refund.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createRefundSchema, listRefundsQuery, rejectRefundSchema, idParamSchema } = require('../validators/refund.validator');

router.use(authenticate);

router.get('/', requirePermission('refunds.view'), validate({ query: listRefundsQuery }), controller.list);
router.post('/', requirePermission('refunds.create'), validate({ body: createRefundSchema }), controller.create);
router.get('/:id', requirePermission('refunds.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/approve', requirePermission('refunds.approve'), validate({ params: idParamSchema }), controller.approve);
router.post('/:id/reject', requirePermission('refunds.approve'), validate({ params: idParamSchema, body: rejectRefundSchema }), controller.reject);

module.exports = router;
