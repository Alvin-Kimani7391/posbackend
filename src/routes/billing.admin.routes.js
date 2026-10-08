/** Mounted by admin.routes.js at /billing, i.e. /api/v1/admin/billing/* - already behind authenticate + requireSuperAdmin. */
const router = require('express').Router();
const c = require('../controllers/billing.admin.controller');
const validate = require('../middleware/validate');
const v = require('../validators/billing.validator');

const biz = { params: v.businessParamSchema };
const id = { params: v.idParamSchema };

router.get('/overview', c.overview);
router.post('/run-cycle', c.runCycle);
router.post('/backfill', validate({ body: v.backfillSchema }), c.backfill);

router.get('/settings', c.getSettings);
router.put('/settings', validate({ body: v.settingsSchema }), c.updateSettings);
router.post('/settings/test', c.testStk);

router.get('/plans', c.listPlans);
router.post('/plans', validate({ body: v.planCreateSchema }), c.createPlan);
router.get('/plans/:id', validate(id), c.getPlan);
router.put('/plans/:id', validate({ ...id, body: v.planUpdateSchema }), c.updatePlan);
router.patch('/plans/:id/active', validate({ ...id, body: v.planActiveSchema }), c.setPlanActive);

router.get('/subscriptions', validate({ query: v.subsQuery }), c.listSubscriptions);
router.get('/businesses/:businessId', validate(biz), c.getBusinessBilling);
router.post('/businesses/:businessId/start', validate({ ...biz, body: v.startSchema }), c.start);
router.patch('/businesses/:businessId/plan', validate({ ...biz, body: v.changePlanSchema }), c.changePlan);
router.post('/businesses/:businessId/extend-trial', validate({ ...biz, body: v.extendTrialSchema }), c.extendTrial);
router.post('/businesses/:businessId/lock', validate({ ...biz, body: v.lockSchema }), c.lock);
router.post('/businesses/:businessId/unlock', validate({ ...biz, body: v.unlockSchema }), c.unlock);
router.patch('/businesses/:businessId/policy', validate({ ...biz, body: v.policySchema }), c.policy);
router.post('/businesses/:businessId/invoices', validate({ ...biz, body: v.invoiceCreateSchema }), c.createInvoice);
router.post('/businesses/:businessId/payments', validate({ ...biz, body: v.recordPaymentSchema }), c.recordPayment);
router.post('/businesses/:businessId/notice', validate({ ...biz, body: v.noticeSchema }), c.notice);
router.post('/businesses/:businessId/remind', validate(biz), c.remind);

router.patch('/invoices/:id', validate({ ...id, body: v.invoiceAdjustSchema }), c.adjustInvoice);
router.post('/invoices/:id/void', validate({ ...id, body: v.voidSchema }), c.voidInvoice);

router.get('/payments', validate({ query: v.paymentsQuery }), c.listPayments);
router.get('/payments/:id', validate(id), c.getPayment);
router.post('/payments/:id/approve', validate({ ...id, body: v.approveSchema }), c.approvePayment);
router.post('/payments/:id/reject', validate({ ...id, body: v.rejectSchema }), c.rejectPayment);

module.exports = router;