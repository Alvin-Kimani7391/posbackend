const router = require('express').Router();
const controller = require('../controllers/purchase.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createPurchaseSchema, listPurchasesQuery, recordPaymentSchema, idParamSchema } = require('../validators/purchase.validator');

router.use(authenticate);

router.get('/', requirePermission('purchases.view'), validate({ query: listPurchasesQuery }), controller.list);
router.post('/', requirePermission('purchases.create'), validate({ body: createPurchaseSchema }), controller.create);
router.get('/:id', requirePermission('purchases.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/receive', requirePermission('purchases.receive'), validate({ params: idParamSchema }), controller.receive);
router.post('/:id/payments', requirePermission('purchases.pay'), validate({ params: idParamSchema, body: recordPaymentSchema }), controller.recordPayment);

module.exports = router;
