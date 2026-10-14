const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const vehicles = require('../services/vehicle.service');
const jobcards = require('../services/jobcard.service');

const { smsResult } = require('../utils/smsResult');

// ---- vehicles
exports.createVehicle = catchAsync(async (req, res) => sendSuccess(res, 201, 'Vehicle registered', { vehicle: await vehicles.createVehicle(req.businessId, req.user._id, req.body) }));
exports.updateVehicle = catchAsync(async (req, res) => sendSuccess(res, 200, 'Vehicle updated', { vehicle: await vehicles.updateVehicle(req.businessId, req.user._id, req.params.id, req.body) }));
exports.getVehicle = catchAsync(async (req, res) => sendSuccess(res, 200, 'Vehicle fetched', { vehicle: await vehicles.getVehicle(req.businessId, req.params.id) }));
exports.lookupVehicle = catchAsync(async (req, res) => sendSuccess(res, 200, 'Vehicle found', await vehicles.lookup(req.businessId, req.query)));
exports.listVehicles = catchAsync(async (req, res) => sendSuccess(res, 200, 'Vehicles fetched', await vehicles.listVehicles(req.businessId, req.query)));
exports.vehicleHistory = catchAsync(async (req, res) => sendSuccess(res, 200, 'Service history fetched', await vehicles.serviceHistory(req.businessId, req.params.id, req.query)));
exports.dueForService = catchAsync(async (req, res) => sendSuccess(res, 200, 'Vehicles due for service fetched', { vehicles: await vehicles.dueForService(req.businessId, req.query) }));

// ---- job cards
exports.createJobCard = catchAsync(async (req, res) => sendSuccess(res, 201, 'Job card opened', { job: await jobcards.createJob(req.businessId, req.body.branchId, req.user, req.body) }));
exports.listJobCards = catchAsync(async (req, res) => sendSuccess(res, 200, 'Job cards fetched', await jobcards.listJobs(req.businessId, req.query)));
exports.jobCardSummary = catchAsync(async (req, res) => sendSuccess(res, 200, 'Garage summary fetched', await jobcards.summary(req.businessId, req.query)));
exports.uncollected = catchAsync(async (req, res) => sendSuccess(res, 200, 'Uncollected vehicles fetched', { jobs: await jobcards.uncollected(req.businessId, req.query) }));
exports.getJobCard = catchAsync(async (req, res) => sendSuccess(res, 200, 'Job card fetched', { job: await jobcards.getJob(req.businessId, req.params.id) }));
exports.estimate = catchAsync(async (req, res) => sendSuccess(res, 200, 'Estimate saved', { job: await jobcards.updateEstimate(req.businessId, req.user._id, req.params.id, req.body) }));
exports.approval = catchAsync(async (req, res) => sendSuccess(res, 200, 'Approval recorded', { job: await jobcards.recordApproval(req.businessId, req.user._id, req.params.id, req.body) }));
exports.issuePart = catchAsync(async (req, res) => sendSuccess(res, 200, 'Part issued', { job: await jobcards.issuePart(req.businessId, req.user._id, req.params.id, req.params.partId) }));
exports.returnPart = catchAsync(async (req, res) => sendSuccess(res, 200, 'Part returned to stock', { job: await jobcards.returnPart(req.businessId, req.user._id, req.params.id, req.params.partId) }));
exports.labourDone = catchAsync(async (req, res) => sendSuccess(res, 200, 'Labour updated', { job: await jobcards.markLabourDone(req.businessId, req.user._id, req.params.id, req.params.labourId, req.body.done) }));
exports.action = catchAsync(async (req, res) => sendSuccess(res, 200, 'Job card updated', { job: await jobcards.transition(req.businessId, req.user._id, req.params.id, req.body.action, req.body.note) }));
exports.qualityCheck = catchAsync(async (req, res) => sendSuccess(res, 200, 'Quality check recorded', { job: await jobcards.qualityCheck(req.businessId, req.user, req.params.id, req.body) }));
exports.cancelJobCard = catchAsync(async (req, res) => sendSuccess(res, 200, 'Job card cancelled', { job: await jobcards.cancelJob(req.businessId, req.user._id, req.params.id, req.body) }));
exports.payment = catchAsync(async (req, res) => sendSuccess(res, 200, 'Payment recorded', { job: await jobcards.recordPayment(req.businessId, req.user, req.params.id, req.body) }));
exports.notifyReady = catchAsync(async (req, res) => sendSuccess(res, 200, 'Notification processed', smsResult(await jobcards.notifyReady(req.businessId, req.params.id))));
exports.collect = catchAsync(async (req, res) => sendSuccess(res, 200, 'Vehicle handed over', { job: await jobcards.collect(req.businessId, req.user, req.params.id, req.body) }));