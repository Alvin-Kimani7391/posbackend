const router = require('express').Router();

router.use('/auth', require('../auth.routes'));
router.use('/business', require('../business.routes'));
router.use('/branches', require('../branch.routes'));
router.use('/employees', require('../employee.routes'));

// Phase 2+ will mount: products, categories, inventory, sales, payments,
// customers, suppliers, purchases, expenses, refunds, registers, shifts,
// reports, etims, audit-logs, sync, devices.

module.exports = router;
