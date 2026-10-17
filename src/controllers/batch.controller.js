const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const batchService = require('../services/batch.service');

exports.list = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Batches fetched', await batchService.listBatches(req.businessId, req.query)));

exports.expiring = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Expiry report fetched', await batchService.listExpiring(req.businessId, req.query)));

exports.quarantine = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Batch quarantined', { batch: await batchService.quarantineBatch(req.businessId, req.user._id, req.params.id, req.body) }));

exports.release = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Batch released', { batch: await batchService.releaseBatch(req.businessId, req.user._id, req.params.id, req.body) }));

exports.dispose = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Batch written off', { batch: await batchService.disposeBatch(req.businessId, req.user._id, req.params.id, req.body) }));

exports.recall = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Batches recalled', await batchService.recallByBatchNumber(req.businessId, req.user._id, req.body)));

exports.trace = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Sales traced', { sales: await batchService.tracedSales(req.businessId, [req.params.id]) }));

exports.unbatched = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Stock without batch fetched', await batchService.listUnbatched(req.businessId, req.query)));

exports.backfill = catchAsync(async (req, res) =>
  sendSuccess(res, 201, 'Expiry recorded for existing stock', { batch: await batchService.backfillBatch(req.businessId, req.user._id, req.body) }));

exports.available = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Available batches fetched', { batches: await batchService.listAvailable(req.businessId, req.query) }));

exports.getAlertSettings = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Expiry alert settings fetched', await batchService.getAlertSettings(req.businessId)));

exports.updateAlertSettings = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Expiry alert settings saved', await batchService.updateAlertSettings(req.businessId, req.body)));

// "Run it now": recomputes and notifies management immediately (the daily job does the same on a schedule).
exports.runAlertsNow = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Expiry check done', await require('../services/expiryAlerts.service').runForBusiness(req.businessId, { force: true })));
