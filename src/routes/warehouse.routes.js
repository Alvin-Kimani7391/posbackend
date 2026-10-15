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

// Wholesale sale dashboard feed + settings
router.get('/catalog', requirePermission('inventory.view'), requireBranchAccess, validate({ query: v.catalogQuery }), controller.catalog);
router.get('/settings', requirePermission('inventory.view'), controller.getSettings);
router.put('/settings', requirePermission('warehouses.manage'), validate({ body: v.wholesaleSettingsSchema }), controller.updateSettings);

// Stock + transfers (warehouse <-> retail, warehouse <-> warehouse, with unit conversion and retail pricing)
router.get('/stock', requirePermission('inventory.view'), requireBranchAccess, validate({ query: v.warehouseListQuery }), controller.listStock);
router.get('/reconcile', requirePermission('inventory.view'), requireBranchAccess, validate({ query: v.overviewQuery }), controller.reconcile);
router.get('/transfers', requirePermission('inventory.view'), validate({ query: v.listLocationTransfersQuery }), controller.listTransfers);
router.get('/transfers/:id', requirePermission('inventory.view'), validate({ params: v.idParamSchema }), controller.getTransfer);
router.post('/transfers', requirePermission('inventory.transfer'), validate({ body: v.locationTransferSchema }), controller.transfer);

// Warehouses CRUD (several per business, any branch)
router.get('/', requirePermission('inventory.view'), validate({ query: v.warehousesQuery }), controller.listWarehouses);
router.post('/', requirePermission('warehouses.manage'), validate({ body: v.createWarehouseSchema }), controller.createWarehouse);
router.get('/:id', requirePermission('inventory.view'), validate({ params: v.idParamSchema }), controller.getWarehouse);
router.patch('/:id', requirePermission('warehouses.manage'), validate({ params: v.idParamSchema, body: v.updateWarehouseSchema }), controller.updateWarehouse);
router.post('/:id/adjust', requirePermission('inventory.adjust'), validate({ params: v.idParamSchema, body: v.adjustWarehouseSchema }), controller.adjust);

module.exports = router;
