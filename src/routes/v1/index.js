const router = require('express').Router();

router.use(require('../../middleware/subscriptionGate')); // first (adjust path to where you keep middleware)

router.use('/auth', require('../auth.routes'));
router.use('/billing', require('../billing.routes'));
router.use('/business', require('../business.routes'));
router.use('/branches', require('../branch.routes'));
router.use('/employees', require('../employee.routes'));
router.use('/categories', require('../category.routes'));
router.use('/products', require('../product.routes'));
router.use('/inventory', require('../inventory.routes'));
router.use('/transfers', require('../transfer.routes'));
router.use('/sales', require('../sale.routes'));
router.use('/customers', require('../customer.routes'));
router.use('/crm', require('../crm.routes'));
router.use('/registers', require('../register.routes'));
router.use('/shifts', require('../shift.routes'));
router.use('/shortages', require('../shortage.routes'));
router.use('/payments', require('../payment.routes'));

router.use('/payments/mpesa', require('../mpesa.routes'));
router.use('/settings/integrations', require('../integration-settings.routes'));
router.use('/etims', require('../etims.routes'));

router.use('/suppliers', require('../supplier.routes'));
router.use('/purchases', require('../purchase.routes'));
router.use('/expenses', require('../expense.routes'));
router.use('/refunds', require('../refund.routes'));
router.use('/reports', require('../report.routes'));
router.use('/audit-logs', require('../auditlog.routes'));
router.use('/notifications', require('../notification.routes'));
router.use('/tickets', require('../ticket.routes'));
router.use('/announcements', require('../announcement.routes'));
router.use('/admin', require('../admin.routes'));

router.use('/sms', require('../sms.routes'));
router.use('/sms-hooks', require('../sms.webhook.routes'));

module.exports = router;