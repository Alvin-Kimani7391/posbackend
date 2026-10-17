const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const receiptService = require('../services/receipt.service');

/** POST /receipts/verify  { token } | { receiptNumber }  - any signed-in staff member of the business. */
exports.verify = catchAsync(async (req, res) => {
  const result = await receiptService.verify(req.user, req.body, { ip: req.ip, userAgent: req.headers['user-agent'] });
  return sendSuccess(res, 200, result.verdict === 'FAKE' ? 'Receipt not recognised' : 'Receipt checked', result);
});
