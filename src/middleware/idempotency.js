const IdempotencyKey = require('../models/IdempotencyKey');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

/**
 * idempotent(routeName) - wrap a financial POST route.
 *
 * If the client sends an `Idempotency-Key` header:
 *   - First time seen for this business+route+key: proceeds normally, then
 *     stores the final response so a retry returns the SAME result instead
 *     of creating a second sale/payment/refund.
 *   - Already completed: short-circuits and replays the stored response.
 *   - Still "pending" (an identical request is genuinely in flight right
 *     now, e.g. a double-tap): rejects with 409 rather than racing it.
 *
 * If no header is sent, the request just proceeds without idempotency
 * protection (the caller opted out).
 */
function idempotent(routeName) {
  return catchAsync(async (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return next();

    const existing = await IdempotencyKey.findOne({ businessId: req.businessId, route: routeName, key });

    if (existing) {
      if (existing.status === 'completed') {
        return res.status(existing.responseStatus).json(existing.responseBody);
      }
      throw ApiError.conflict('An identical request is already being processed', 'DUPLICATE_IN_FLIGHT');
    }

    try {
      await IdempotencyKey.create({ businessId: req.businessId, userId: req.user?._id, route: routeName, key, status: 'pending' });
    } catch (err) {
      if (err.code === 11000) {
        throw ApiError.conflict('An identical request is already being processed', 'DUPLICATE_IN_FLIGHT');
      }
      throw err;
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      IdempotencyKey.updateOne(
        { businessId: req.businessId, route: routeName, key },
        { status: 'completed', responseStatus: res.statusCode, responseBody: body }
      ).catch(() => {});
      return originalJson(body);
    };

    next();
  });
}

module.exports = idempotent;
