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

const manualStartSchema = z.object({
  branchId: objectId,
  amountCents: z.coerce.number().int().positive(),
});

const claimSchema = z.object({
  receiptCode: z.string().trim().refine((v) => /^[A-Za-z][A-Za-z0-9]{9}$/.test(v), 'Enter the 10-character M-PESA code'),
});

const manualSetupSchema = z.object({
  enabled: z.boolean().optional(),
  tillNumber: z.string().trim().regex(/^\d{5,8}$/, 'Till number must be 5-8 digits').optional(),
  regenerateToken: z.boolean().optional(),
});

const callbackLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const tillWebhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 }); // PayHero till notifications - one per customer payment

router.post('/callback/:businessId', callbackLimiter, controller.callback);
router.post('/c2b/:businessId/:token', tillWebhookLimiter, controller.inboundCallback);



router.use(authenticate);
router.post('/stk', requirePermission('sales.create'), requireBranchAccess, validate({ body: stkSchema }), controller.stkPush);

// Manual (Buy Goods / Till) payments
router.post('/manual', requirePermission('sales.create'), requireBranchAccess, validate({ body: manualStartSchema }), controller.manualStart);
router.get('/manual/setup', requirePermission('settings.view'), controller.manualSetupGet); // owner-only, enforced again in the service
router.put('/manual/setup', requirePermission('settings.update'), validate({ body: manualSetupSchema }), controller.manualSetupUpdate); // owner-only, enforced again in the service
router.post('/:reference/cancel', requirePermission('sales.create'), controller.manualCancel);
router.post('/:reference/claim', requirePermission('sales.create'), validate({ body: claimSchema }), controller.manualClaim);

router.get('/:reference/status', requirePermission('sales.create'), controller.status);

module.exports = router;