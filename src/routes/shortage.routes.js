const router = require('express').Router();
const controller = require('../controllers/shortage.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { listShortagesQuery, summaryQuery, shortagePaymentSchema, idParamSchema } = require('../validators/shortage.validator');

router.use(authenticate);

router.get('/', requirePermission('shortages.view'), validate({ query: listShortagesQuery }), controller.list);
router.get('/summary', requirePermission('shortages.view'), validate({ query: summaryQuery }), controller.summary); // before /:id
router.get('/:id', requirePermission('shortages.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/payments', requirePermission('shortages.manage'), validate({ params: idParamSchema, body: shortagePaymentSchema }), controller.pay);

module.exports = router;