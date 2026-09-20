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

// Phase 5+ will mount: suppliers, purchases, expenses, refunds, reports,
// etims, audit-logs, sync, devices.

module.exports = router;
