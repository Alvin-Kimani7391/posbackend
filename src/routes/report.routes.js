const router = require('express').Router();
const controller = require('../controllers/report.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { reportQuery, inventoryReportQuery } = require('../validators/report.validator');

router.use(authenticate);

// Self-scoped - no reports.view required. Every employee can see their own
// numbers; the controller locks cashierId to req.user._id and branchId to
// the caller's own branches.
router.get('/me', validate({ query: reportQuery }), controller.myDashboard);

router.use(requirePermission('reports.view'));

router.get('/dashboard', validate({ query: reportQuery }), controller.dashboard);
router.get('/sales', validate({ query: reportQuery }), controller.sales);
router.get('/profit', requirePermission('reports.profit'), validate({ query: reportQuery }), controller.profit);
router.get('/inventory', validate({ query: inventoryReportQuery }), controller.inventory);
router.get('/payments', validate({ query: reportQuery }), controller.payments);
router.get('/cashiers', validate({ query: reportQuery }), controller.cashiers);
router.get('/expenses', validate({ query: reportQuery }), controller.expenses);
router.get('/customers', controller.customers);
router.get('/suppliers', controller.suppliers);

module.exports = router;