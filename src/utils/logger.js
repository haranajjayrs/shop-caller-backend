/* Minimal structured logger — swap for winston/pino if needed later */
const log = (level, message, meta = {}) => {
  if (process.env.NODE_ENV === "test" && !process.env.DEBUG_LOGS) return;
  const entry = { level, message, timestamp: new Date().toISOString(), ...meta };
  console.log(JSON.stringify(entry));
};

module.exports = {
  info: (message, meta) => log("info", message, meta),
  error: (message, meta) => log("error", message, meta),
  warn: (message, meta) => log("warn", message, meta),
};
