const router = require('express').Router();
const controller = require('../controllers/report.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { reportQuery, reportDetailQuery, inventoryReportQuery } = require('../validators/report.validator');

router.use(authenticate);

router.get('/me', validate({ query: reportQuery }), controller.myDashboard);

router.use(requirePermission('reports.view'));

router.get('/dashboard', validate({ query: reportQuery }), controller.dashboard);
router.get('/sales', validate({ query: reportQuery }), controller.sales);
router.get('/sales/detail', validate({ query: reportDetailQuery }), controller.salesDetail);
router.get('/payments/detail', validate({ query: reportDetailQuery }), controller.paymentsDetail);
router.get('/expenses/detail', validate({ query: reportDetailQuery }), controller.expensesDetail);
router.get('/profit', requirePermission('reports.profit'), validate({ query: reportQuery }), controller.profit);
router.get('/inventory', validate({ query: inventoryReportQuery }), controller.inventory);
router.get('/payments', validate({ query: reportQuery }), controller.payments);
router.get('/cashiers', validate({ query: reportQuery }), controller.cashiers);
router.get('/expenses', validate({ query: reportQuery }), controller.expenses);
router.get('/customers', controller.customers);
router.get('/suppliers', controller.suppliers);

module.exports = router;