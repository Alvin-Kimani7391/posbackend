const router = require('express').Router();
const controller = require('../controllers/purchase-return.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createPurchaseReturnSchema, listPurchaseReturnsQuery, recordRefundSchema, holdCreditSchema, idParamSchema } = require('../validators/purchase-return.validator');

router.use(authenticate);

// reading returns needs purchases.view; making one or settling the refund needs purchases.return
router.get('/', requirePermission('purchases.view'), validate({ query: listPurchaseReturnsQuery }), controller.list);
router.get('/summary', requirePermission('purchases.view'), controller.summary);
router.get('/purchase/:id/eligibility', requirePermission('purchases.return'), validate({ params: idParamSchema }), controller.eligible);
router.post('/purchase/:id', requirePermission('purchases.return'), validate({ params: idParamSchema, body: createPurchaseReturnSchema }), controller.create);
router.get('/:id', requirePermission('purchases.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/refund', requirePermission('purchases.return'), validate({ params: idParamSchema, body: recordRefundSchema }), controller.recordRefund);
router.post('/:id/hold-credit', requirePermission('purchases.return'), validate({ params: idParamSchema, body: holdCreditSchema }), controller.holdCredit);

module.exports = router;