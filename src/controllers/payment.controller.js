const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const paymentService = require('../services/payment.service');

exports.list = catchAsync(async (req, res) => {
  const result = await paymentService.listPayments(req.businessId, req.query);
  return sendSuccess(res, 200, 'Payments fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const payment = await paymentService.getPayment(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Payment fetched', { payment });
});
