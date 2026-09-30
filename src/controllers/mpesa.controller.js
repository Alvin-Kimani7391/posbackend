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
  // Diagnostic only - never logs credentials, just confirms whether PayHero
  // is actually reaching this endpoint and what shape their payload takes.
  console.log('[mpesa callback] received', { businessId: req.params.businessId, body: req.body });
  await mpesaService.handleCallback(req.params.businessId, req.body);
  return res.status(200).json({ received: true }); // PayHero just needs a 200
});

/* ---------------- Manual (Buy Goods / Till) payments ---------------- */

exports.manualStart = catchAsync(async (req, res) => {
  const txn = await mpesaService.initiateManual(req.businessId, req.body.branchId, req.user, req.body);
  return sendSuccess(res, 201, 'Waiting for the customer to pay to the Till number', {
    reference: txn.reference, status: txn.status, tillNumber: txn.tillNumber, amount: txn.amount,
  });
});

exports.manualCancel = catchAsync(async (req, res) => {
  const status = await mpesaService.cancelManual(req.businessId, req.params.reference);
  return sendSuccess(res, 200, 'Request updated', status);
});

exports.manualClaim = catchAsync(async (req, res) => {
  const status = await mpesaService.claimByCode(req.businessId, req.params.reference, req.user, req.body.receiptCode);
  return sendSuccess(res, 200, 'Payment confirmed', status);
});

// PUBLIC - PayHero posts "a customer paid the Till" here. Protected by the secret :token path segment
// (see IntegrationSettings.mpesa.webhookToken). businessId + token both come from the URL we gave PayHero.
exports.inboundCallback = catchAsync(async (req, res) => {
  if (process.env.MPESA_LOG_WEBHOOKS !== '0') {
    // Diagnostic: shows exactly what shape PayHero sends for till payments. Set MPESA_LOG_WEBHOOKS=0 to silence.
    console.log('[mpesa till webhook] received', { businessId: req.params.businessId, body: req.body });
  }
  const outcome = await mpesaService.ingestInboundPayment(req.params.businessId, req.params.token, req.body);
  if (outcome.ignored) console.warn('[mpesa till webhook] ignored', { businessId: req.params.businessId, reason: outcome.ignored });
  return res.status(200).json({ received: true }); // always 200 for an authenticated notification so PayHero does not retry-storm
});

exports.manualSetupGet = catchAsync(async (req, res) => {
  const data = await mpesaService.getManualSetup(req.businessId, req.user);
  return sendSuccess(res, 200, 'Manual M-PESA setup fetched', data);
});

exports.manualSetupUpdate = catchAsync(async (req, res) => {
  const data = await mpesaService.updateManualSetup(req.businessId, req.user, req.body);
  return sendSuccess(res, 200, 'Manual M-PESA setup saved', data);
});