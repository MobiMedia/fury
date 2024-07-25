const crypto = require("crypto");

exports.DEFAULT_TIMEOUT = 30 * 1000;

exports.getError = (e) => {
  return e.stack || e.toString();
}

exports.createUniqueFileName = (extension = "") => {
  const uniqueId = crypto.randomBytes(16).toString("hex");
  const timestamp = Date.now();
  return `${uniqueId}-${timestamp}${extension ? `.${extension}` : ""}`;
}

exports.log = (message) => {
  console.log(`${new Date().toISOString()} ${message}`);
}