const router = require('express').Router();

router.use('/auth', require('../auth.routes'));
router.use('/business', require('../business.routes'));
router.use('/branches', require('../branch.routes'));
router.use('/employees', require('../employee.routes'));
router.use('/categories', require('../category.routes'));
router.use('/products', require('../product.routes'));
router.use('/inventory', require('../inventory.routes'));
router.use('/transfers', require('../transfer.routes'));

// Phase 4+ will mount: sales, payments, customers, suppliers, purchases,
// expenses, refunds, registers, shifts, reports, etims, audit-logs, sync,
// devices.

module.exports = router;
