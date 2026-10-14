const router = require('express').Router();
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const alerts = require('../services/sms/alerts.service');
const AuditLog = require('../models/AuditLog');
const v = require('../validators/smsAlerts.validator');

router.use(authenticate);

router.get('/settings', requirePermission('settings.view'), catchAsync(async (req, res) => sendSuccess(res, 200, 'SMS alert settings fetched', await alerts.getSettings(req.businessId))));

router.put('/settings', requirePermission('settings.update'), validate({ body: v.updateSettingsSchema }), catchAsync(async (req, res) => {
  const out = await alerts.updateSettings(req.businessId, req.body);
  await AuditLog.create({ businessId: req.businessId, userId: req.user._id, action: 'smsAlerts.update', entityType: 'Business', entityId: req.businessId, newValue: req.body });
  sendSuccess(res, 200, 'SMS alert settings saved', out);
}));

router.post('/preview', requirePermission('settings.view'), validate({ body: v.previewSchema }), catchAsync(async (req, res) => sendSuccess(res, 200, 'Preview', alerts.preview(req.body.kind, req.body.template))));

router.get('/messages', requirePermission('reports.view'), validate({ query: v.messagesQuery }), catchAsync(async (req, res) => sendSuccess(res, 200, 'Alert messages fetched', await alerts.listMessages(req.businessId, req.query))));

module.exports = router;