import type { Request, RequestHandler } from 'express';
import {
  verifyAccessToken,
  type Authenticated,
  type TokenSettings,
} from '../../application/auth/tokens.js';
import { unauthorized } from './errors.js';

/** Where the verified identity is parked for the rest of the request. */
const IDENTITY = Symbol('authenticated');

interface RequestWithIdentity extends Request {
  [IDENTITY]?: Authenticated;
}

export function authenticate(settings: TokenSettings): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || token === undefined || token === '') {
      next(unauthorized('missing_token', 'expected an Authorization: Bearer header'));
      return;
    }

    try {
      (req as RequestWithIdentity)[IDENTITY] = verifyAccessToken(token, settings);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * The user making this request. Only call this behind authenticate(),
 * which is exactly why it throws instead of returning null: reaching here
 * without an identity means the route was wired up wrong.
 */
export function currentUser(req: Request): Authenticated {
  const identity = (req as RequestWithIdentity)[IDENTITY];

  if (identity === undefined) {
    throw new Error('currentUser() used on a route without authenticate()');
  }

  return identity;
}
