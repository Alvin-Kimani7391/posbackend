const ApiError = require('../utils/ApiError');

module.exports = (...fields) => (req, res, next) => {
  for (const f of fields) {
    if (typeof req.body[f] === 'string') {
      try { req.body[f] = JSON.parse(req.body[f]); }
      catch { return next(ApiError.badRequest(`Invalid ${f}`, 'INVALID_JSON')); }
    }
  }
  next();
};