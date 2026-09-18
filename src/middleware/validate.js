const ApiError = require('../utils/ApiError');

/**
 * validate({ body, params, query }) -- each value is a Zod schema.
 * Parses and REPLACES req.body/params/query with the parsed (typed, defaulted)
 * result so controllers can trust the shape of their input.
 */
function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      next();
    } catch (err) {
      const errors = (err.errors || []).map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      next(ApiError.badRequest('Validation failed', 'VALIDATION_ERROR', errors));
    }
  };
}

module.exports = validate;
