const router = require('express').Router();
const controller = require('../controllers/category.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createCategorySchema, updateCategorySchema, idParamSchema } = require('../validators/category.validator');

router.use(authenticate);

router.get('/', requirePermission('categories.view'), controller.list);
router.post('/', requirePermission('categories.create'), validate({ body: createCategorySchema }), controller.create);
router.get('/:id', requirePermission('categories.view'), validate({ params: idParamSchema }), controller.getOne);
router.put('/:id', requirePermission('categories.update'), validate({ params: idParamSchema, body: updateCategorySchema }), controller.update);
router.delete('/:id', requirePermission('categories.delete'), validate({ params: idParamSchema }), controller.remove);

module.exports = router;
