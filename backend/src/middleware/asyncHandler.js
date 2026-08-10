// Express 4 does not catch rejected promises thrown from async route handlers —
// an unhandled rejection there just hangs the request. Wrap every async handler
// with this so rejections reach the error-handling middleware in server.js.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
