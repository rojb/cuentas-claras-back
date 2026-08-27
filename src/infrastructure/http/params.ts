import type { Request } from 'express';
import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * The path parameters as what they actually are: a bag of unknown strings.
 *
 * Express infers a params type from the route pattern, which stops being
 * true the moment a router is mounted with mergeParams and inherits its
 * parent's. Reading them as unknown and validating is honest either way.
 */
export function pathParams(req: Request): Record<string, unknown> {
  return req.params as Record<string, unknown>;
}

/**
 * A path parameter is untrusted input exactly like a body is.
 *
 * Without this, a non-uuid id reaches Postgres and comes back as a raw 22P02
 * driver error, which the error handler can only turn into a 500: a mistake
 * by the client, dressed up as a failure of ours.
 *
 * Typed `unknown` on purpose. Express types params loosely depending on the
 * middleware in the chain, and pretending otherwise would only move the lie
 * somewhere harder to see.
 */
export function readUuid(value: unknown, label: string): string {
  const parsed = z.uuid().safeParse(value);

  if (!parsed.success) {
    throw badRequest(
      `invalid_${label}_id`,
      `the ${label} id is not a valid uuid`,
    );
  }

  return parsed.data;
}
