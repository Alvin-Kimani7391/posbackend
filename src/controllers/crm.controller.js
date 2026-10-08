const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const crm = require('../services/crm.service');
const AuditLog = require('../models/AuditLog');

const audit = (req, action, entityId, newValue) =>
  AuditLog.create({ businessId: req.businessId, userId: req.user._id, action, entityType: 'CrmSegment', entityId, newValue })
    .catch((e) => console.error('[crm] audit failed', e.message));

exports.overview = catchAsync(async (req, res) => {
  const data = await crm.getOverview(req.businessId);
  return sendSuccess(res, 200, 'CRM overview fetched', data);
});

exports.listCustomers = catchAsync(async (req, res) => {
  const q = { ...req.query, page: Number(req.query.page) || 1, limit: Number(req.query.limit) || 25 };
  const data = await crm.listCustomers(req.businessId, q);
  return sendSuccess(res, 200, 'Customers fetched', data);
});

exports.getProfile = catchAsync(async (req, res) => {
  const data = await crm.getProfile(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Customer profile fetched', data);
});

exports.updateTags = catchAsync(async (req, res) => {
  const tags = await crm.updateTags(req.businessId, req.params.id, req.body.tags);
  return sendSuccess(res, 200, 'Tags saved', { tags });
});

/* ---------------- segments ---------------- */
exports.listSegments = catchAsync(async (req, res) => {
  const items = await crm.listSegments(req.businessId);
  return sendSuccess(res, 200, 'Segments fetched', { items });
});

exports.previewSegment = catchAsync(async (req, res) => {
  const data = await crm.previewSegment(req.businessId, req.body);
  return sendSuccess(res, 200, 'Preview ready', data);
});

exports.createSegment = catchAsync(async (req, res) => {
  const segment = await crm.createSegment(req.businessId, req.user._id, req.body);
  audit(req, 'crm.segment.create', segment._id, { name: segment.name });
  return sendSuccess(res, 201, 'Segment created', { segment });
});

exports.updateSegment = catchAsync(async (req, res) => {
  const segment = await crm.updateSegment(req.businessId, req.params.id, req.body);
  audit(req, 'crm.segment.update', segment._id, { name: segment.name });
  return sendSuccess(res, 200, 'Segment updated', { segment });
});

exports.deleteSegment = catchAsync(async (req, res) => {
  await crm.deleteSegment(req.businessId, req.params.id);
  audit(req, 'crm.segment.delete', req.params.id, {});
  return sendSuccess(res, 200, 'Segment deleted', {});
});

/* ---------------- settings + rebuild ---------------- */
exports.getSettings = catchAsync(async (req, res) => {
  const settings = await crm.getSettings(req.businessId);
  return sendSuccess(res, 200, 'CRM settings fetched', { settings });
});

exports.updateSettings = catchAsync(async (req, res) => {
  const settings = await crm.updateSettings(req.businessId, req.body);
  audit(req, 'crm.settings.update', settings._id, req.body);
  return sendSuccess(res, 200, 'CRM settings saved', { settings });
});

exports.startRebuild = catchAsync(async (req, res) => {
  const rebuild = crm.startRebuild(req.businessId);
  return sendSuccess(res, 202, 'Rebuild started', { rebuild });
});

exports.rebuildStatus = catchAsync(async (req, res) => {
  return sendSuccess(res, 200, 'Rebuild status', { rebuild: crm.getRebuildStatus(req.businessId) });
});