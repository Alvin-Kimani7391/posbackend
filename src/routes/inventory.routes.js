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
} = require('../validators/inventory.validator');

router.use(authenticate);

router.get('/', requirePermission('inventory.view'), requireBranchAccess, validate({ query: listInventoryQuery }), controller.list);
router.get('/low-stock', requirePermission('inventory.view'), validate({ query: lowStockQuery }), controller.lowStock);
router.get('/movements', requirePermission('inventory.view'), validate({ query: movementsQuery }), controller.movements);
router.post('/adjust', requirePermission('inventory.adjust'), requireBranchAccess, validate({ body: adjustStockSchema }), controller.adjust);
router.post('/receive', requirePermission('inventory.receive'), requireBranchAccess, validate({ body: receiveStockSchema }), controller.receive);

module.exports = router;
