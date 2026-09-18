// Wraps an async controller/middleware so rejected promises are forwarded to next()
module.exports = function catchAsync(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
