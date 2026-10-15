const router = require('express').Router();
const controller = require('../controllers/warehouse.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/warehouse.validator');

router.use(authenticate);

// Combined books view (retail + warehouse + total per product). Available to every business.
router.get('/overview', requirePermission('inventory.view'), requireBranchAccess, validate({ query: v.overviewQuery }), controller.overview);

// Everything below needs the multiWarehouse feature (on by default for wholesale businesses).
router.use(requireFeature('multiWarehouse'));
router.get('/', requirePermission('inventory.view'), requireBranchAccess, validate({ query: v.warehouseListQuery }), controller.listWarehouse);
router.get('/reconcile', requirePermission('inventory.view'), requireBranchAccess, validate({ query: v.overviewQuery }), controller.reconcile);
router.get('/transfers', requirePermission('inventory.view'), requireBranchAccess, validate({ query: v.listLocationTransfersQuery }), controller.listTransfers);
router.get('/transfers/:id', requirePermission('inventory.view'), validate({ params: v.idParamSchema }), controller.getTransfer);
router.post('/transfers', requirePermission('inventory.transfer'), requireBranchAccess, validate({ body: v.locationTransferSchema }), controller.transfer);

module.exports = router;
