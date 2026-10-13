const router = require('express').Router();
const controller = require('../controllers/stocktake.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/stocktake.validator');

router.use(authenticate);

router.get('/', requirePermission('stocktake.view'), validate({ query: v.listQuery }), controller.list);
router.post('/', requirePermission('stocktake.manage'), requireBranchAccess, validate({ body: v.createStocktakeSchema }), controller.create);
router.get('/:id', requirePermission('stocktake.view'), validate({ params: v.idParamSchema }), controller.getOne);
router.put('/:id/counts', requirePermission('stocktake.count'), validate({ params: v.idParamSchema, body: v.recordCountsSchema }), controller.count);
router.post('/:id/submit', requirePermission('stocktake.count'), validate({ params: v.idParamSchema, body: v.submitSchema }), controller.submit);
router.post('/:id/approve', requirePermission('stocktake.approve'), validate({ params: v.idParamSchema, body: v.approveSchema }), controller.approve);
router.post('/:id/cancel', requirePermission('stocktake.manage'), validate({ params: v.idParamSchema, body: v.cancelSchema }), controller.cancel);

module.exports = router;