import type { ErrorRequestHandler, RequestHandler } from 'express';

/**
 * An error we MEANT to produce: the client did something we can explain.
 *
 * Anything else that reaches the handler is a bug on our side, and the
 * client gets a plain 500 with no internals leaked into the response.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (code: string, message: string) =>
  new AppError(401, code, message);

export const forbidden = (code: string, message: string) =>
  new AppError(403, code, message);

export const notFound = (code: string, message: string) =>
  new AppError(404, code, message);

export const conflict = (code: string, message: string) =>
  new AppError(409, code, message);

/**
 * 400 means "I could not read that". 422 means "I read it perfectly and it
 * still does not work": the percentages add up to 66%, the items do not
 * match the total. Well-formed, and impossible.
 */
export const unprocessable = (code: string, message: string) =>
  new AppError(422, code, message);

/**
 * 503 means "we are fine, but something we depend on is not". The client
 * should try again later, or carry on without whatever this was going to
 * give it — which for a live exchange rate means letting the user type it.
 */
export const serviceUnavailable = (code: string, message: string) =>
  new AppError(503, code, message);

export const routeNotFound: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'route_not_found', message: `${req.method} ${req.path} does not exist` },
  });
};

/**
 * The single place where an error becomes an HTTP response.
 *
 * Express 5 forwards rejected promises here on its own, so route handlers
 * can just throw and stop worrying about try/catch.
 */
export const handleErrors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  // Not planned for: log it in full for us, say nothing useful to the client.
  console.error('unhandled error', error);

  res.status(500).json({
    error: { code: 'internal_error', message: 'something went wrong on our side' },
  });
};
