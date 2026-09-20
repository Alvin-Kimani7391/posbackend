const router = require('express').Router();
const controller = require('../controllers/customer.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const {
  createCustomerSchema, updateCustomerSchema, setCreditLimitSchema, recordPaymentSchema, listCustomersQuery, idParamSchema,
} = require('../validators/customer.validator');
const { paginationQuery } = require('../validators/common');

router.use(authenticate);

router.get('/', requirePermission('customers.view'), validate({ query: listCustomersQuery }), controller.list);
router.post('/', requirePermission('customers.create'), validate({ body: createCustomerSchema }), controller.create);
router.get('/:id', requirePermission('customers.view'), validate({ params: idParamSchema }), controller.getOne);
router.put('/:id', requirePermission('customers.update'), validate({ params: idParamSchema, body: updateCustomerSchema }), controller.update);
router.patch('/:id/credit-limit', requirePermission('customers.update'), validate({ params: idParamSchema, body: setCreditLimitSchema }), controller.setCreditLimit);
router.get('/:id/ledger', requirePermission('customers.view'), validate({ params: idParamSchema, query: paginationQuery }), controller.getLedger);
router.post('/:id/payment', requirePermission('payments.view'), validate({ params: idParamSchema, body: recordPaymentSchema }), controller.recordPayment);

module.exports = router;
