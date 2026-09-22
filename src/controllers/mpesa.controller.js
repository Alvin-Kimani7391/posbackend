const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const mpesaService = require('../services/mpesa.service');

exports.stkPush = catchAsync(async (req, res, next) => {
  try {
    const txn = await mpesaService.initiateStk(req.businessId, req.body.branchId, req.user, req.body);
    return sendSuccess(res, 201, 'STK push sent - check the customer\u2019s phone', {
      reference: txn.reference, status: txn.status,
    });
  } catch (err) {
    // A send-time failure (bad creds, rate limit, network) has no PENDING
    // transaction the frontend can poll - surface it as the immediate
    // response so the cashier sees it instantly instead of via polling.
    if (err.mpesaFailureType) {
      return res.status(err.statusCode || 502).json({
        success: false, message: err.message, code: err.code,
        data: { failureType: err.mpesaFailureType },
      });
    }
    return next(err);
  }
});

exports.status = catchAsync(async (req, res) => {
  const status = await mpesaService.getStatus(req.businessId, req.params.reference);
  return sendSuccess(res, 200, 'Status fetched', status);
});

// PUBLIC - no `authenticate`. businessId comes from the URL (set by us when
// we built the callback_url), not from a session, so PayHero can reach it.
exports.callback = catchAsync(async (req, res) => {
  await mpesaService.handleCallback(req.params.businessId, req.body);
  return res.status(200).json({ received: true }); // PayHero just needs a 200
});