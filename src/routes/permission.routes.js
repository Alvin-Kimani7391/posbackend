const router = require('express').Router();
const c = require('../controllers/permission.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const v = require('../validators/permission.validator');

router.use(authenticate);

// Anyone signed in may read their OWN effective permissions (the app uses this to stay in sync).
router.get('/me', c.me);

// Everything below changes or reveals who can do what: owner-only unless the owner delegates `employees.permissions`.
router.use(requirePermission('employees.permissions'));

router.get('/catalog', c.catalog);
router.get('/policy', c.policy);

router.put('/roles/:role', validate({ params: v.roleParam, body: v.templateSchema }), c.setRole);
router.delete('/roles/:role', validate({ params: v.roleParam }), c.resetRole);

router.post('/groups', validate({ body: v.groupSchema }), c.createGroup);
router.put('/groups/:groupId', validate({ params: v.groupParam, body: v.groupUpdateSchema }), c.updateGroup);
router.delete('/groups/:groupId', validate({ params: v.groupParam }), c.deleteGroup);

router.get('/employees', c.listEmployees);
router.post('/employees/bulk', validate({ body: v.bulkSchema }), c.bulk);
router.get('/employees/:id', validate({ params: v.idParam }), c.getEmployee);
router.put('/employees/:id', validate({ params: v.idParam, body: v.employeeAccessSchema }), c.updateEmployee);

module.exports = router;
