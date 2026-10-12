const logger = require("../utils/logger");

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // multer file-size / file-type errors
  if (err.code === "LIMIT_FILE_SIZE") {
    err.statusCode = 400;
    err.message = "File is too large (max 5 MB)";
  }

  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) {
    logger.error(err.message, { stack: err.stack, path: req.path });
  }
  res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 ? "Something went wrong. Please try again." : err.message,
  });
}

module.exports = errorHandler;
