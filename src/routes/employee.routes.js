const router = require('express').Router();
const controller = require('../controllers/employee.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { paginationQuery } = require('../validators/common');
const {
  createEmployeeSchema,
  updateEmployeeSchema,
  statusSchema,
  idParamSchema,
} = require('../validators/employee.validator');

router.use(authenticate);

router.get('/', requirePermission('employees.view'), validate({ query: paginationQuery }), controller.list);
router.post('/', requirePermission('employees.create'), validate({ body: createEmployeeSchema }), controller.create);
router.get('/:id', requirePermission('employees.view'), validate({ params: idParamSchema }), controller.getOne);
router.put('/:id', requirePermission('employees.update'), validate({ params: idParamSchema, body: updateEmployeeSchema }), controller.update);
router.patch('/:id/status', requirePermission('employees.update'), validate({ params: idParamSchema, body: statusSchema }), controller.setStatus);
router.delete('/:id', requirePermission('employees.delete'), validate({ params: idParamSchema }), controller.remove);

module.exports = router;
