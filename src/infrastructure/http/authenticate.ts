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

export interface AuthenticateOptions {
  /**
   * Also accept ?access_token= from the query string.
   *
   * OFF EVERYWHERE EXCEPT THE EVENT STREAM, and it should stay that way. A
   * token in a URL is a token in the browser history, in the referrer of
   * anything the page loads next, and in the access log of every proxy on the
   * way — none of which is true of a header. It is enabled for the SSE route
   * because EventSource has no way to set a header at all, so the choice
   * there is this or an unauthenticated stream of somebody's group activity.
   *
   * What keeps the blast radius small: it is one route, it is a read, and the
   * token is the same short-lived access token everything else uses, so it
   * expires on its own rather than sitting in a log being valid forever.
   */
  readonly allowQueryToken?: boolean;
}

export function authenticate(
  settings: TokenSettings,
  options: AuthenticateOptions = {},
): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, headerToken] = header.split(' ');

    const queryToken = options.allowQueryToken
      ? readQueryToken(req.query.access_token)
      : undefined;

    // The header wins when both are present: it is the one every other route
    // uses, and honouring the query string over it would let a link decide
    // who you are on a request that already said.
    const token =
      scheme === 'Bearer' && headerToken !== undefined && headerToken !== ''
        ? headerToken
        : queryToken;

    if (token === undefined || token === '') {
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

/** Express hands back a string, an array, or an object. Only a lone string. */
function readQueryToken(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
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
