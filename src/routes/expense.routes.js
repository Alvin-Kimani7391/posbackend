const router = require('express').Router();
const controller = require('../controllers/expense.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createExpenseSchema, listExpensesQuery, rejectExpenseSchema, idParamSchema } = require('../validators/expense.validator');

router.use(authenticate);

router.get('/', requirePermission('expenses.view'), validate({ query: listExpensesQuery }), controller.list);
router.post('/', requirePermission('expenses.create'), validate({ body: createExpenseSchema }), controller.create);
router.get('/:id', requirePermission('expenses.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/approve', requirePermission('expenses.approve'), validate({ params: idParamSchema }), controller.approve);
router.post('/:id/reject', requirePermission('expenses.approve'), validate({ params: idParamSchema, body: rejectExpenseSchema }), controller.reject);

module.exports = router;
