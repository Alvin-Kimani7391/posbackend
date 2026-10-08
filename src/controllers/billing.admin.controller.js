const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const svc = require('../services/billing.admin.service');

const wrap = (message, fn, status = 200) =>
  catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));

exports.overview = wrap('Billing overview fetched', () => svc.overview());
exports.listSubscriptions = wrap('Subscriptions fetched', (r) => svc.listSubscriptions(r.query));
exports.getBusinessBilling = wrap('Billing details fetched', (r) => svc.getBusinessBilling(r.params.businessId));
exports.start = wrap('Subscription started', async (r) => ({ subscription: await svc.startForBusiness(r.user, r.params.businessId, r.body) }), 201);
exports.backfill = wrap('Backfill complete', (r) => svc.backfill(r.user, r.body));
exports.changePlan = wrap('Plan changed', async (r) => ({ subscription: await svc.changePlan(r.user, r.params.businessId, r.body) }));
exports.extendTrial = wrap('Trial extended', async (r) => ({ subscription: await svc.extendTrial(r.user, r.params.businessId, r.body) }));
exports.lock = wrap('Business locked', async (r) => ({ subscription: await svc.lockBusiness(r.user, r.params.businessId, r.body) }));
exports.unlock = wrap('Business unlocked', async (r) => ({ subscription: await svc.unlockBusiness(r.user, r.params.businessId, r.body) }));
exports.policy = wrap('Policy updated', async (r) => ({ subscription: await svc.setPolicy(r.user, r.params.businessId, r.body) }));
exports.createInvoice = wrap('Invoice created', async (r) => ({ invoice: await svc.createInvoice(r.user, r.params.businessId, r.body) }), 201);
exports.adjustInvoice = wrap('Invoice updated', async (r) => ({ invoice: await svc.adjustInvoice(r.user, r.params.id, r.body) }));
exports.voidInvoice = wrap('Invoice voided', async (r) => ({ invoice: await svc.voidInvoice(r.user, r.params.id, r.body) }));
exports.recordPayment = wrap('Payment recorded', async (r) => ({ payment: await svc.recordPayment(r.user, r.params.businessId, r.body) }), 201);
exports.notice = wrap('Notice sent', (r) => svc.sendNotice(r.user, r.params.businessId, r.body));
exports.remind = wrap('Reminder sent', (r) => svc.sendReminderNow(r.user, r.params.businessId));

exports.listPayments = wrap('Payments fetched', (r) => svc.listPayments(r.query));
exports.getPayment = wrap('Payment fetched', (r) => svc.getPayment(r.params.id));
exports.approvePayment = wrap('Payment approved', async (r) => ({ payment: await svc.approvePayment(r.user, r.params.id, r.body) }));
exports.rejectPayment = wrap('Payment rejected', async (r) => ({ payment: await svc.rejectPayment(r.user, r.params.id, r.body) }));

exports.listPlans = wrap('Plans fetched', () => svc.listPlans());
exports.getPlan = wrap('Plan fetched', (r) => svc.getPlan(r.params.id));
exports.createPlan = wrap('Plan created', async (r) => ({ plan: await svc.createPlan(r.user, r.body) }), 201);
exports.updatePlan = wrap('Plan updated', async (r) => ({ plan: await svc.updatePlan(r.user, r.params.id, r.body) }));
exports.setPlanActive = wrap('Plan updated', async (r) => ({ plan: await svc.setPlanActive(r.user, r.params.id, r.body.isActive) }));

exports.getSettings = wrap('Settings fetched', () => svc.getSettingsStatus());
exports.updateSettings = wrap('Settings saved', (r) => svc.updateSettings(r.user, r.body));
exports.testStk = wrap('Test complete', () => svc.testStk());
exports.runCycle = wrap('Billing cycle finished', () => svc.runCycle());