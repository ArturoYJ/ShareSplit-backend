function sendError(res, status, message, code, details) {
  const payload = { error: message };
  if (code) payload.code = code;
  if (details !== undefined) payload.details = details;
  return res.status(status).json(payload);
}

class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = { sendError, HttpError };
