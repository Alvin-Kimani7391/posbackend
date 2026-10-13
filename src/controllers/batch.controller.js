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