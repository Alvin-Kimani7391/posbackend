const router = require('express').Router();

router.use('/auth', require('../auth.routes'));
router.use('/business', require('../business.routes'));
router.use('/branches', require('../branch.routes'));
router.use('/employees', require('../employee.routes'));
router.use('/categories', require('../category.routes'));
router.use('/products', require('../product.routes'));
router.use('/inventory', require('../inventory.routes'));
router.use('/transfers', require('../transfer.routes'));
router.use('/sales', require('../sale.routes'));
router.use('/customers', require('../customer.routes'));
router.use('/registers', require('../register.routes'));
router.use('/shifts', require('../shift.routes'));
router.use('/payments', require('../payment.routes'));

/ routes/v1/index.js
router.use('/payments/mpesa', require('../mpesa.routes'));
router.use('/settings/integrations', require('../integration-settings.routes'));
router.use('/etims', require('../etims.routes'));

router.use('/suppliers', require('../supplier.routes'));
router.use('/purchases', require('../purchase.routes'));
router.use('/expenses', require('../expense.routes'));
router.use('/refunds', require('../refund.routes'));
router.use('/reports', require('../report.routes'));
router.use('/audit-logs', require('../auditlog.routes'));

// Phase 7+ will mount: etims,  devices, notifications.

module.exports = router;