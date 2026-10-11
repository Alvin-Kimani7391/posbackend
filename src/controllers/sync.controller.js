const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const syncService = require('../services/sync.service');

const secretOf = (req) => req.headers['x-device-secret'];

exports.push = catchAsync(async (req, res) => {
  const result = await syncService.pushBatch({
    businessId: req.businessId, user: req.user, secret: secretOf(req),
    deviceId: req.body.deviceId, deviceTime: req.body.deviceTime, pendingCount: req.body.pendingCount,
    appVersion: req.body.appVersion, items: req.body.items,
  });
  return sendSuccess(res, 200, 'Sync processed', result);
});

exports.context = catchAsync(async (req, res) => {
  const result = await syncService.getContext(req.businessId, req.user, req.query.deviceId, secretOf(req));
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, 200, 'Context fetched', result);
});

exports.catalog = catchAsync(async (req, res) => {
  const result = await syncService.getCatalogPage(req.businessId, req.user, {
    deviceId: req.query.deviceId, secret: secretOf(req), type: req.query.type,
    cursor: req.query.cursor, since: req.query.since, limit: req.query.limit,
  });
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, 200, 'Catalog fetched', result);
});

exports.catalogIds = catchAsync(async (req, res) => {
  const result = await syncService.getCatalogIds(req.businessId, req.user, req.query.deviceId, secretOf(req));
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, 200, 'Catalog ids fetched', result);
});