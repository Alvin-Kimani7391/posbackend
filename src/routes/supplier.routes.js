const router = require('express').Router();
const controller = require('../controllers/supplier.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createSupplierSchema, updateSupplierSchema, listSuppliersQuery, idParamSchema } = require('../validators/supplier.validator');

router.use(authenticate);

router.get('/', requirePermission('suppliers.view'), validate({ query: listSuppliersQuery }), controller.list);
router.post('/', requirePermission('suppliers.create'), validate({ body: createSupplierSchema }), controller.create);
router.get('/:id', requirePermission('suppliers.view'), validate({ params: idParamSchema }), controller.getOne);
router.put('/:id', requirePermission('suppliers.update'), validate({ params: idParamSchema, body: updateSupplierSchema }), controller.update);

module.exports = router;
