const router = require('express').Router();
const c = require('../controllers/supplier-finance.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const v = require('../validators/supplier-finance.validator');

router.use(authenticate);

// Supplier invoices (a purchase is the supplier's invoice): record what the supplier billed, match it, approve variances
router.post('/purchases/:id/invoice', requirePermission('purchases.pay'), validate({ params: v.idParam, body: v.supplierInvoiceSchema }), c.recordInvoice);
router.post('/purchases/:id/invoice/approve', requirePermission('purchases.pay'), validate({ params: v.idParam, body: v.approveVarianceSchema }), c.approveVariance);

// Payments to suppliers, allocated to invoices (oldest due first unless allocations are given)
router.get('/payments', requirePermission('purchases.view'), validate({ query: v.paymentsQuery }), c.listPayments);
router.post('/payments', requirePermission('purchases.pay'), validate({ body: v.supplierPaymentSchema }), c.pay);
router.post('/payments/:id/void', requirePermission('purchases.pay'), validate({ params: v.idParam, body: v.voidPaymentSchema }), c.voidPayment);

// Statements and payables ageing
router.get('/ageing', requirePermission('purchases.view'), validate({ query: v.ageingQuery }), c.ageing);
router.get('/suppliers/:supplierId/statement', requirePermission('purchases.view'), validate({ params: v.supplierIdParam, query: v.statementQuery }), c.statement);

module.exports = router;
