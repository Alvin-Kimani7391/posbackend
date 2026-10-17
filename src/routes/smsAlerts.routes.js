const router = require('express').Router();
const validate = require('../middleware/validate');
const requireCountry = require('../middleware/requireCountry');
const { authenticate, requirePermission } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const alerts = require('../services/sms/alerts.service');
const { smsResult } = require('../utils/smsResult');
const AuditLog = require('../models/AuditLog');
const v = require('../validators/smsAlerts.validator');

router.use(authenticate);
router.use(requireCountry('KE')); // Kenya-only integration (PayHero M-PESA / KRA eTIMS / Kenyan SMS)

router.get('/settings', requirePermission('settings.view'), catchAsync(async (req, res) => sendSuccess(res, 200, 'SMS alert settings fetched', await alerts.getSettings(req.businessId))));

router.put('/settings', requirePermission('settings.update'), validate({ body: v.updateSettingsSchema }), catchAsync(async (req, res) => {
  const out = await alerts.updateSettings(req.businessId, req.body);
  await AuditLog.create({ businessId: req.businessId, userId: req.user._id, action: 'smsAlerts.update', entityType: 'Business', entityId: req.businessId, newValue: req.body });
  sendSuccess(res, 200, 'SMS alert settings saved', out);
}));

router.post('/preview', requirePermission('settings.view'), validate({ body: v.previewSchema }), catchAsync(async (req, res) => sendSuccess(res, 200, 'Preview', alerts.preview(req.body.kind, req.body.template))));

// "Send now": texts the owner(s) the current low-stock summary (once an hour at most; uses SMS credits).
router.post('/low-stock/send-now', requirePermission('settings.update'), catchAsync(async (req, res) => {
  const lowStockAlerts = require('../services/lowStockAlerts.service');
  sendSuccess(res, 200, 'Low stock check done', await lowStockAlerts.runForBusiness(req.businessId, { manual: true }));
}));

// "Send me a test text": one credit, goes to the logged-in owner's own phone, ignores quiet hours.
router.post('/test', requirePermission('settings.update'), catchAsync(async (req, res) => {
  const r = await alerts.sendOwnerTest(req.businessId, req.user._id);
  const out = smsResult(r);
  if (r.queued) out.message = `A test text is on its way to ${r.to}. It should arrive within a minute.`;
  sendSuccess(res, 200, out.sent ? 'Test text queued' : 'Test text not sent', out);
}));

router.get('/messages', requirePermission('reports.view'), validate({ query: v.messagesQuery }), catchAsync(async (req, res) => sendSuccess(res, 200, 'Alert messages fetched', await alerts.listMessages(req.businessId, req.query))));

module.exports = router;