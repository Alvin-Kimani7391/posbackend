const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const engine = require('../services/billing.service');
const pay = require('../services/billing.payment.service');

exports.status = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Billing status fetched', await engine.getStatusLight(req.businessId, req.user)));

exports.overview = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Billing overview fetched', await engine.getOverview(req.businessId)));

exports.invoices = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Invoices fetched', await engine.listInvoices(req.businessId, req.query)));

exports.payments = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Payments fetched', await engine.listPayments(req.businessId, req.query)));

exports.stk = catchAsync(async (req, res, next) => {
  try {
    const p = await pay.initiateStk(req.businessId, req.user, req.body);
    return sendSuccess(res, 201, 'Payment prompt sent - check the phone', { payment: pay.toClient(p) });
  } catch (err) {
    // Send-time failures have nothing to poll, so surface the failure type immediately (same pattern as the POS STK).
    if (err.mpesaFailureType) {
      return res.status(err.statusCode || 502).json({ success: false, message: err.message, code: err.code, data: { failureType: err.mpesaFailureType } });
    }
    return next(err);
  }
});

exports.manual = catchAsync(async (req, res) => {
  const p = await pay.submitManual(req.businessId, req.user, req.body);
  return sendSuccess(res, 201, 'Payment submitted for verification', { payment: pay.toClient(p) });
});

exports.paymentStatus = catchAsync(async (req, res) =>
  sendSuccess(res, 200, 'Payment status fetched', { payment: await pay.getPaymentStatus(req.businessId, req.params.id) }));

// PUBLIC - PayHero calls this. The URL token is per-payment; money is only credited after a live status check.
exports.callback = catchAsync(async (req, res) => {
  const out = await pay.handleCallback(req.params.paymentId, req.params.token, req.body);
  if (out.forbidden) return res.status(403).json({ success: false, message: 'Invalid callback' });
  return res.status(200).json({ received: true });
});