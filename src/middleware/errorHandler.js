const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let { statusCode, message, code, errors } = err;

  if (!(err instanceof ApiError)) {
    statusCode = 500;
    code = 'INTERNAL_ERROR';
    errors = [];

    // Common Mongoose errors get friendlier mapping
    if (err.name === 'ValidationError') {
      statusCode = 400;
      code = 'VALIDATION_ERROR';
      message = 'Validation failed';
      errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    } else if (err.name === 'CastError') {
      statusCode = 400;
      code = 'INVALID_ID';
      message = `Invalid value for ${err.path}`;
    } else if (err.code === 11000) {
      statusCode = 409;
      code = 'DUPLICATE_KEY';
      const field = Object.keys(err.keyPattern || {}).join(', ');
      message = `Duplicate value for field: ${field}`;
    } else {
      message = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    }
  }

  logger.error(message, {
    code,
    statusCode,
    requestId: req.id,
    userId: req.user?._id?.toString(),
    businessId: req.businessId?.toString(),
    path: req.originalUrl,
    method: req.method,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });

  res.status(statusCode || 500).json({
    success: false,
    message,
    code: code || 'INTERNAL_ERROR',
    errors: errors || [],
  });
}

function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

module.exports = { errorHandler, notFoundHandler };
