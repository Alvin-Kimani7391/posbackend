const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const review = require('../services/offline-review.service');
const mpesa = require('../services/offline-mpesa.service');

exports.listSales = catchAsync(async (req, res) => sendSuccess(res, 200, 'Sales fetched', await review.listReviewSales(req.businessId, req.query)));
exports.resolveSale = catchAsync(async (req, res) => {
  const sale = await review.resolveSale(req.businessId, req.user, req.params.id, req.body.note);
  return sendSuccess(res, 200, 'Sale review resolved', { sale });
});

exports.listClaims = catchAsync(async (req, res) => sendSuccess(res, 200, 'M-PESA claims fetched', await mpesa.listClaims(req.businessId, req.query)));
exports.approveClaim = catchAsync(async (req, res) => {
  const claim = await mpesa.approveClaim(req.businessId, req.user, req.params.id, req.body.note);
  return sendSuccess(res, 200, 'M-PESA payment approved', { claim });
});
exports.rejectClaim = catchAsync(async (req, res) => {
  const claim = await mpesa.rejectClaim(req.businessId, req.user, req.params.id, req.body.note, !!req.body.chargeCashier);
  return sendSuccess(res, 200, 'M-PESA payment rejected', { claim });
});

exports.listQuarantine = catchAsync(async (req, res) => sendSuccess(res, 200, 'Held sales fetched', await review.listRejections(req.businessId, req.query)));
exports.getQuarantine = catchAsync(async (req, res) => sendSuccess(res, 200, 'Held sale fetched', { rejection: await review.getRejection(req.businessId, req.params.id) }));
exports.release = catchAsync(async (req, res) => sendSuccess(res, 200, 'Sale accepted', await review.releaseRejection(req.businessId, req.user, req.params.id, req.body.note)));
exports.discard = catchAsync(async (req, res) => {
  const rejection = await review.discardRejection(req.businessId, req.user, req.params.id, req.body.note);
  return sendSuccess(res, 200, 'Sale discarded', { rejection });
});

exports.gaps = catchAsync(async (req, res) => sendSuccess(res, 200, 'Gap report', await review.detectGaps(req.businessId, req.query.deviceId)));

exports.listShifts = catchAsync(async (req, res) => sendSuccess(res, 200, 'Shifts fetched', await review.listReviewShifts(req.businessId, req.query)));
exports.resolveShift = catchAsync(async (req, res) => {
  const shift = await review.resolveShift(req.businessId, req.user, req.params.id, req.body.note);
  return sendSuccess(res, 200, 'Shift review resolved', { shift });
});
exports.summary = catchAsync(async (req, res) => sendSuccess(res, 200, 'Offline summary', await review.getSummary(req.businessId)));