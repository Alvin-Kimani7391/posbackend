class ApiError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   * @param {string} code - machine-readable error code, e.g. INSUFFICIENT_STOCK
   * @param {Array} errors - field-level validation errors
   */
  constructor(statusCode, message, code = 'ERROR', errors = []) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, code = 'BAD_REQUEST', errors = []) {
    return new ApiError(400, message, code, errors);
  }

  static unauthorized(message = 'Not authenticated', code = 'UNAUTHENTICATED') {
    return new ApiError(401, message, code);
  }

  static forbidden(message = 'Not authorized', code = 'FORBIDDEN') {
    return new ApiError(403, message, code);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, message, code);
  }

  static conflict(message, code = 'CONFLICT') {
    return new ApiError(409, message, code);
  }

  static internal(message = 'Internal server error', code = 'INTERNAL_ERROR') {
    return new ApiError(500, message, code);
  }
  static externalService(message, code) {
  return new ApiError(502, message, code || 'EXTERNAL_SERVICE_ERROR');
}
}

module.exports = ApiError;
