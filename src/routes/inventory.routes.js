const router = require('express').Router();
const controller = require('../controllers/inventory.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');

const {
  listInventoryQuery,
  lowStockQuery,
  movementsQuery,
  adjustStockSchema,
  receiveStockSchema,
  breakDownSchema,
  economicsQuery,
  productIdParam,
  breaksQuery,
} = require('../validators/inventory.validator');

router.use(authenticate);

router.get('/', requirePermission('inventory.view'), requireBranchAccess, validate({ query: listInventoryQuery }), controller.list);
router.get('/low-stock', requirePermission('inventory.view'), validate({ query: lowStockQuery }), controller.lowStock);
router.get('/valuation', requirePermission('inventory.view'), requireBranchAccess, controller.valuation);
router.get('/movements', requirePermission('inventory.view'), validate({ query: movementsQuery }), controller.movements);
router.post('/adjust', requirePermission('inventory.adjust'), requireBranchAccess, validate({ body: adjustStockSchema }), controller.adjust);
router.post('/receive', requirePermission('inventory.receive'), requireBranchAccess, validate({ body: receiveStockSchema }), controller.receive);

// Dynamic unit conversion: price breakdown per unit, and breaking a bag into sellable sizes.
router.get('/unit-economics/:productId', requirePermission('inventory.view'), validate({ params: productIdParam, query: economicsQuery }), controller.unitEconomics);
router.get('/breaks', requirePermission('inventory.view'), validate({ query: breaksQuery }), controller.listBreaks);
router.post('/break/preview', requirePermission('inventory.view'), requireBranchAccess, validate({ body: breakDownSchema }), controller.previewBreak);
router.post('/break', requirePermission('inventory.adjust'), requireBranchAccess, validate({ body: breakDownSchema }), controller.breakDown);

module.exports = router;