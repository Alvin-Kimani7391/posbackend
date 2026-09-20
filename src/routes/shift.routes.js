const router = require('express').Router();
const controller = require('../controllers/shift.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { openShiftSchema, closeShiftSchema, listShiftsQuery, currentShiftQuery, idParamSchema } = require('../validators/shift.validator');

router.use(authenticate);

router.get('/current', requirePermission('shifts.view'), validate({ query: currentShiftQuery }), controller.current);
router.get('/', requirePermission('shifts.view'), validate({ query: listShiftsQuery }), controller.list);
router.post('/open', requirePermission('shifts.open'), validate({ body: openShiftSchema }), controller.open);
router.get('/:id', requirePermission('shifts.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/close', requirePermission('shifts.close'), validate({ params: idParamSchema, body: closeShiftSchema }), controller.close);

module.exports = router;
