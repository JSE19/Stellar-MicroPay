/**
 * src/middleware/errorHandler.js
 * Central Express error-handling middleware and AppError class (#1422).
 *
 * Enforces a single, consistent error envelope across all backend routes:
 * {
 *   "code": string,       // Machine-readable code (e.g., "BAD_REQUEST", "NOT_FOUND")
 *   "message": string,    // Human-readable explanation
 *   "error": string,      // Backward compatibility alias for message
 *   "details": any,       // Structured error details or null
 *   "requestId": string   // Request correlation UUID
 * }
 */

"use strict";

const crypto = require("crypto");

const STATUS_TO_CODE = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  410: "GONE",
  422: "UNPROCESSABLE_ENTITY",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
  504: "GATEWAY_TIMEOUT",
};

class AppError extends Error {
  /**
   * @param {number} status - HTTP status code
   * @param {string} message - Human-readable error message
   * @param {string} [code] - Machine-readable error code
   * @param {*} [details=null] - Optional extra error details
   */
  constructor(status, message, code, details = null) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code || STATUS_TO_CODE[status] || "INTERNAL_SERVER_ERROR";
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Extract or generate a correlation Request ID.
 */
function resolveRequestId(req, res) {
  if (req && req.requestId && typeof req.requestId === "string") {
    return req.requestId;
  }
  const fromHeader =
    req && req.get
      ? req.get("x-request-id")
      : req && req.headers
        ? req.headers["x-request-id"]
        : null;
  if (fromHeader && typeof fromHeader === "string" && fromHeader.trim()) {
    const trimmed = fromHeader.trim();
    if (req) req.requestId = trimmed;
    return trimmed;
  }
  if (res && typeof res.getHeader === "function") {
    const resHeader = res.getHeader("X-Request-ID");
    if (resHeader && typeof resHeader === "string") return resHeader;
  }
  const generated =
    crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}`;
  if (req) req.requestId = generated;
  return generated;
}

/**
 * Central Express error-handling middleware.
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const status =
    typeof err.status === "number" && err.status >= 400 && err.status <= 599
      ? err.status
      : typeof err.statusCode === "number" &&
          err.statusCode >= 400 &&
          err.statusCode <= 599
        ? err.statusCode
        : 500;

  const message =
    typeof err.message === "string" && err.message.trim()
      ? err.message
      : "Internal Server Error";

  const code =
    typeof err.code === "string" && err.code.trim()
      ? err.code
      : STATUS_TO_CODE[status] || "INTERNAL_SERVER_ERROR";

  const details = err.details !== undefined ? err.details : null;
  const requestId = resolveRequestId(req, res);

  if (res.setHeader && !res.getHeader("X-Request-ID")) {
    res.setHeader("X-Request-ID", requestId);
  }

  if (req.log && typeof req.log.error === "function") {
    req.log.error({ err, requestId, status, code }, "Request error handled");
  }

  return res.status(status).json({
    code,
    message,
    error: message,
    details,
    requestId,
  });
}

/**
 * 404 Route Not Found middleware.
 */
function notFoundHandler(req, res, next) {
  const method = req.method || "GET";
  const url = req.originalUrl || req.url || "";
  const err = new AppError(
    404,
    `Route not found: ${method} ${url}`,
    "NOT_FOUND",
  );
  next(err);
}

module.exports = {
  AppError,
  errorHandler,
  notFoundHandler,
  STATUS_TO_CODE,
  resolveRequestId,
};
