const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

function requestContext(req, res, next) {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.id);

  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', {
      requestId: req.id,
      userId: req.user?._id?.toString(),
      businessId: req.businessId?.toString(),
      branchId: req.branchId?.toString(),
      route: req.originalUrl,
      method: req.method,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });

  next();
}

module.exports = requestContext;
