const router = require('express').Router();
const controller = require('../controllers/transfer.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createTransferSchema, listTransfersQuery, idParamSchema } = require('../validators/inventory.validator');

router.use(authenticate);

router.get('/', requirePermission('inventory.view'), validate({ query: listTransfersQuery }), controller.list);
router.post('/', requirePermission('inventory.transfer'), validate({ body: createTransferSchema }), controller.create);
router.get('/:id', requirePermission('inventory.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/approve', requirePermission('inventory.transfer'), validate({ params: idParamSchema }), controller.approve);
router.post('/:id/dispatch', requirePermission('inventory.transfer'), validate({ params: idParamSchema }), controller.dispatch);
router.post('/:id/receive', requirePermission('inventory.transfer'), validate({ params: idParamSchema }), controller.receive);
router.post('/:id/cancel', requirePermission('inventory.transfer'), validate({ params: idParamSchema }), controller.cancel);

module.exports = router;
