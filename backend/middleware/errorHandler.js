/**
 * Custom application error class with HTTP status and safe error code.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 404 Not Found middleware for unmatched routes.
 */
export function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found.`
    }
  });
}

/**
 * Centralized Express error handler.
 * Never logs private student content or exposes stack traces in production.
 */
export function errorHandler(err, req, res, _next) {
  // Handle malformed JSON body
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body contains invalid JSON.'
      }
    });
  }

  // Handle payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds the maximum allowed size.'
      }
    });
  }

  // Handle CORS rejection
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({
      error: {
        code: 'CORS_FORBIDDEN',
        message: 'Origin is not allowed by CORS policy.'
      }
    });
  }

  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const isProd = process.env.NODE_ENV === 'production';

  // Log only safe operational metadata (never request bodies or student content)
  console.error(`[ERROR] ${req.method} ${req.originalUrl} -> ${statusCode} (${code}): ${err.message}`);

  const clientMessage =
    statusCode >= 500 && isProd
      ? 'An unexpected server error occurred. Please try again.'
      : err.message || 'An unexpected error occurred.';

  res.status(statusCode).json({
    error: {
      code,
      message: clientMessage
    }
  });
}
