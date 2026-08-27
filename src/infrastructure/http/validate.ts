import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { badRequest } from './errors.js';

/**
 * Nothing untyped gets past the front door.
 *
 * Everything arriving over HTTP is unknown data written by somebody else.
 * It gets parsed into the exact shape we expect right here, at the edge, so
 * that every layer behind this one works with values it can trust.
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(
        badRequest(
          'invalid_body',
          'the request body is invalid',
          result.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      );
      return;
    }

    req.body = result.data;
    next();
  };
}

/** Reads the body a validateBody() already parsed and trusted. */
export function validatedBody<T>(req: Request): T {
  return req.body as T;
}
