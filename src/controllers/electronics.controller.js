const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const serials = require('../services/serial.service');
const warranty = require('../services/warranty.service');
const repairs = require('../services/repair.service');

const { smsResult } = require('../utils/smsResult');

// ---- serial numbers
exports.listSerials = catchAsync(async (req, res) => sendSuccess(res, 200, 'Serial numbers fetched', await serials.listSerials(req.businessId, req.query)));
exports.lookupSerial = catchAsync(async (req, res) => sendSuccess(res, 200, 'Unit found', await serials.lookup(req.businessId, req.query.serial)));
exports.inspectSerial = catchAsync(async (req, res) => sendSuccess(res, 200, 'Unit inspected', { unit: await serials.inspectReturned(req.businessId, req.user._id, req.params.id, req.body) }));
exports.warrantiesExpiring = catchAsync(async (req, res) => sendSuccess(res, 200, 'Expiring warranties fetched', { units: await serials.warrantiesExpiring(req.businessId, req.query) }));

// ---- warranty claims
exports.createClaim = catchAsync(async (req, res) => sendSuccess(res, 201, 'Claim opened', { claim: await warranty.createClaim(req.businessId, req.body.branchId, req.user._id, req.body) }));
exports.listClaims = catchAsync(async (req, res) => sendSuccess(res, 200, 'Claims fetched', await warranty.listClaims(req.businessId, req.query)));
exports.getClaim = catchAsync(async (req, res) => sendSuccess(res, 200, 'Claim fetched', { claim: await warranty.getClaim(req.businessId, req.params.id) }));
exports.decideClaim = catchAsync(async (req, res) => sendSuccess(res, 200, 'Claim decided', { claim: await warranty.decideClaim(req.businessId, req.user, req.params.id, req.body) }));
exports.supplierRma = catchAsync(async (req, res) => sendSuccess(res, 200, 'Supplier claim recorded', { claim: await warranty.recordSupplierRma(req.businessId, req.user._id, req.params.id, req.body) }));

// ---- repairs
exports.createRepair = catchAsync(async (req, res) => sendSuccess(res, 201, 'Repair job created', { job: await repairs.createJob(req.businessId, req.body.branchId, req.user._id, req.body) }));
exports.listRepairs = catchAsync(async (req, res) => sendSuccess(res, 200, 'Repair jobs fetched', await repairs.listJobs(req.businessId, req.query)));
exports.uncollected = catchAsync(async (req, res) => sendSuccess(res, 200, 'Uncollected devices fetched', { jobs: await repairs.uncollected(req.businessId, req.query) }));
exports.repairSummary = catchAsync(async (req, res) => sendSuccess(res, 200, 'Repair summary fetched', await repairs.summary(req.businessId, req.query)));
exports.getRepair = catchAsync(async (req, res) => sendSuccess(res, 200, 'Repair job fetched', { job: await repairs.getJob(req.businessId, req.params.id) }));
exports.estimate = catchAsync(async (req, res) => sendSuccess(res, 200, 'Estimate saved', { job: await repairs.updateEstimate(req.businessId, req.user._id, req.params.id, req.body) }));
exports.approval = catchAsync(async (req, res) => sendSuccess(res, 200, 'Approval recorded', { job: await repairs.recordApproval(req.businessId, req.user._id, req.params.id, req.body) }));
exports.issuePart = catchAsync(async (req, res) => sendSuccess(res, 200, 'Part issued', { job: await repairs.issuePart(req.businessId, req.user._id, req.params.id, req.params.partId) }));
exports.returnPart = catchAsync(async (req, res) => sendSuccess(res, 200, 'Part returned to stock', { job: await repairs.returnPart(req.businessId, req.user._id, req.params.id, req.params.partId) }));
exports.action = catchAsync(async (req, res) => sendSuccess(res, 200, 'Job updated', { job: await repairs.transition(req.businessId, req.user._id, req.params.id, req.body.action, req.body.note) }));
exports.cancelRepair = catchAsync(async (req, res) => sendSuccess(res, 200, 'Job cancelled', { job: await repairs.cancelJob(req.businessId, req.user._id, req.params.id, req.body) }));
exports.payment = catchAsync(async (req, res) => sendSuccess(res, 200, 'Payment recorded', { job: await repairs.recordPayment(req.businessId, req.user, req.params.id, req.body) }));
exports.notifyReady = catchAsync(async (req, res) => sendSuccess(res, 200, 'Notification processed', smsResult(await repairs.notifyReady(req.businessId, req.params.id))));
exports.collect = catchAsync(async (req, res) => sendSuccess(res, 200, 'Device handed over', { job: await repairs.collect(req.businessId, req.user, req.params.id, req.body) }));