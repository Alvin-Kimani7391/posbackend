const router = require('express').Router();
const controller = require('../controllers/shift.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createRegisterSchema, updateRegisterSchema } = require('../validators/shift.validator');
const { objectId } = require('../validators/common');
const { z } = require('zod');

router.use(authenticate);

router.get('/', requirePermission('registers.view'), validate({ query: z.object({ branchId: objectId.optional() }) }), controller.listRegisters);
router.post('/', requirePermission('registers.manage'), validate({ body: createRegisterSchema }), controller.createRegister);
router.put('/:id', requirePermission('registers.manage'), validate({ params: z.object({ id: objectId }), body: updateRegisterSchema }), controller.updateRegister);

module.exports = router;
