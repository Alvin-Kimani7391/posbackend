const router = require('express').Router();

router.use(require('../../middleware/subscriptionGate')); // first (adjust path to where you keep middleware)

router.use('/meta', require('../meta.routes')); // public: countries, currencies, languages for onboarding
router.use('/auth', require('../auth.routes'));
router.use('/billing', require('../billing.routes'));
router.use('/business', require('../business.routes'));
router.use('/branches', require('../branch.routes'));
router.use('/employees', require('../employee.routes'));
router.use('/categories', require('../category.routes'));
router.use('/products', require('../product.routes'));
router.use('/inventory', require('../inventory.routes'));
router.use('/transfers', require('../transfer.routes'));
router.use('/warehouse', require('../warehouse.routes'));
router.use('/batches', require('../batch.routes'));
router.use('/stocktakes', require('../stocktake.routes'));
router.use('/serials', require('../serial.routes'));
router.use('/warranty-claims', require('../warranty.routes'));
router.use('/repairs', require('../repair.routes'));
router.use('/vehicles', require('../vehicle.routes'));
router.use('/job-cards', require('../jobcard.routes'));
router.use('/pharmacy', require('../pharmacy.routes'));
router.use('/layaways', require('../layaway.routes'));
router.use('/trade-ins', require('../tradein.routes'));
router.use('/sales', require('../sale.routes'));
router.use('/receipts', require('../receipt.routes'));
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
router.use('/supplier-finance', require('../supplier-finance.routes'));
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
router.use('/sms-alerts', require('../smsAlerts.routes'));
router.use('/alert-prefs', require('../alertPrefs.routes'));

router.use('/devices', require('../device.routes'));

router.use('/sync', require('../sync.routes'));
router.use('/offline', require('../offline-review.routes'));

router.use('/restaurant', require('../restaurant.routes'));
router.use('/accommodation', require('../accommodation.routes'));
router.use('/cashier', require('../cashier.routes'));
router.use('/public/qr', require('../guest.public.routes'));
router.use('/public/kiosk', require('../selfservice.public.routes'));
router.use('/public/store', require('../storefront.public.routes'));

module.exports = router;