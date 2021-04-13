exports.DEFAULT_TIMEOUT = 30 * 1000;

exports.getError = (e) => {
  return e.stack || e.toString();
}