const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/mpesa.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const { z } = require('zod');
const { objectId } = require('../validators/common');

const stkSchema = z.object({
  branchId: objectId,
  phone: z.string().trim().min(9),
  amountCents: z.coerce.number().int().positive(),
  customerName: z.string().trim().optional(),
});

const callbackLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 }); // PayHero, not a human - generous but bounded

router.post('/callback/:businessId', callbackLimiter, controller.callback); // PUBLIC, unauthenticated - must stay before authenticate below

router.use(authenticate);
router.post('/stk', requirePermission('sales.create'), requireBranchAccess, validate({ body: stkSchema }), controller.stkPush);
router.get('/:reference/status', requirePermission('sales.create'), controller.status);

module.exports = router;