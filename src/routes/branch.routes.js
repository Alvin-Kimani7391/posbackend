const router = require('express').Router();
const controller = require('../controllers/branch.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { paginationQuery } = require('../validators/common');
const { createBranchSchema, updateBranchSchema, idParamSchema } = require('../validators/branch.validator');

router.use(authenticate);

router.get('/', requirePermission('branches.view'), validate({ query: paginationQuery }), controller.list);
router.post('/', requirePermission('branches.create'), validate({ body: createBranchSchema }), controller.create);
router.get('/:id', requirePermission('branches.view'), validate({ params: idParamSchema }), controller.getOne);
router.put('/:id', requirePermission('branches.update'), validate({ params: idParamSchema, body: updateBranchSchema }), controller.update);
router.delete('/:id', requirePermission('branches.delete'), validate({ params: idParamSchema }), controller.remove);

module.exports = router;
