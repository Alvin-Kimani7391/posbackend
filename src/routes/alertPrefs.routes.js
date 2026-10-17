/**
 * /alert-prefs - the owner's in-app alert switches (the Alerts page). SMS alert settings live under /sms-alerts.
 *   GET  -> { lowStockNotify, outOfStockNotify, expiry: { criticalDays, warningDays, notifyEnabled } }
 *   PUT  -> same shape, every field optional
 */
const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const batchService = require('../services/batch.service');
const notificationService = require('../services/notification.service');

router.use(authenticate);

async function read(businessId) {
  const b = await Business.findById(businessId).select('alertPrefs').lean();
  return {
    lowStockNotify: b?.alertPrefs?.lowStockNotify !== false,
    outOfStockNotify: b?.alertPrefs?.outOfStockNotify !== false,
    expiry: await batchService.getAlertSettings(businessId),
  };
}

const body = z.object({
  lowStockNotify: z.boolean().optional(),
  outOfStockNotify: z.boolean().optional(),
  expiry: z.object({
    criticalDays: z.coerce.number().int().min(1).max(365).optional(),
    warningDays: z.coerce.number().int().min(1).max(730).optional(),
    notifyEnabled: z.boolean().optional(),
  }).optional(),
}).strict();

router.get('/', requirePermission('settings.view'), catchAsync(async (req, res) => sendSuccess(res, 200, 'Alert settings fetched', await read(req.businessId))));

router.put('/', requirePermission('settings.update'), validate({ body }), catchAsync(async (req, res) => {
  const { lowStockNotify, outOfStockNotify, expiry } = req.body;
  const $set = {};
  if (lowStockNotify !== undefined) $set['alertPrefs.lowStockNotify'] = lowStockNotify;
  if (outOfStockNotify !== undefined) $set['alertPrefs.outOfStockNotify'] = outOfStockNotify;
  if (Object.keys($set).length) { await Business.updateOne({ _id: req.businessId }, { $set }); notificationService.forgetStockAlertPrefs(req.businessId); }
  if (expiry) await batchService.updateAlertSettings(req.businessId, expiry);
  await AuditLog.create({ businessId: req.businessId, userId: req.user._id, action: 'alertPrefs.update', entityType: 'Business', entityId: req.businessId, newValue: req.body });
  sendSuccess(res, 200, 'Alert settings saved', await read(req.businessId));
}));

module.exports = router;
