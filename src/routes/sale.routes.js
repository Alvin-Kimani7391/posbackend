const router = require('express').Router();
const controller = require('../controllers/sale.controller');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const { createSaleSchema, listSalesQuery, cancelSaleSchema, idParamSchema } = require('../validators/sale.validator');

router.use(authenticate);

router.get('/', requirePermission('sales.view'), validate({ query: listSalesQuery }), controller.list);
router.post(
  '/',
  requirePermission('sales.create'),
  requireBranchAccess,
  validate({ body: createSaleSchema }),
  idempotent('POST /sales'),
  controller.create
);
router.get('/:id', requirePermission('sales.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/cancel', requirePermission('sales.cancel'), validate({ params: idParamSchema, body: cancelSaleSchema }), controller.cancel);
router.get('/:id/receipt', requirePermission('sales.view'), validate({ params: idParamSchema }), controller.getReceipt);
router.post('/:id/receipt/print', requirePermission('sales.view'), validate({ params: idParamSchema }), controller.printReceipt);

module.exports = router;
