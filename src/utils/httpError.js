class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const forbidden = (msg = "You do not have access to this resource") =>
  new HttpError(403, msg);
const notFound = (msg = "Not found") => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

/** Wraps an async route handler so thrown errors reach the error handler. */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, badRequest, forbidden, notFound, conflict, asyncHandler };
