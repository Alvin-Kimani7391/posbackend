const IdempotencyKey = require('../models/IdempotencyKey');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

const PENDING_TTL_MS = 2 * 60 * 1000;

function idempotent(routeName) {
  return catchAsync(async (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return next();

    const scope = { businessId: req.businessId, route: routeName, key };

    // SPEED: claim the key straight away (1 round trip). Only when it already exists do we read it to decide what to do -
    // the normal first-time request no longer pays for a separate lookup first.
    const claim = () => IdempotencyKey.create({ ...scope, userId: req.user?._id, status: 'pending' });
    try {
      await claim();
    } catch (err) {
      if (err.code !== 11000) throw err;
      const existing = await IdempotencyKey.findOne(scope);
      if (existing) {
        if (existing.status === 'completed') {
          return res.status(existing.responseStatus).json(existing.responseBody);
        }
        if (Date.now() - existing.createdAt.getTime() < PENDING_TTL_MS) {
          throw ApiError.conflict('An identical request is already being processed', 'DUPLICATE_IN_FLIGHT');
        }
        // Abandoned (crash/timeout): release it so the retry can proceed.
        await IdempotencyKey.deleteOne({ _id: existing._id, status: 'pending' });
      }
      try {
        await claim();
      } catch (err2) {
        if (err2.code === 11000) {
          throw ApiError.conflict('An identical request is already being processed', 'DUPLICATE_IN_FLIGHT');
        }
        throw err2;
      }
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const op = res.statusCode < 400
        ? IdempotencyKey.updateOne(scope, { status: 'completed', responseStatus: res.statusCode, responseBody: body })
        : IdempotencyKey.deleteOne({ ...scope, status: 'pending' }); // failures are never cached
      op.catch(() => {});
      return originalJson(body);
    };

    next();
  });
}

module.exports = idempotent;