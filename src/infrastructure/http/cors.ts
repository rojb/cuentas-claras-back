import type { RequestHandler } from 'express';

/**
 * Lets a browser talk to this API from a different origin.
 *
 * Native clients never needed this: Android and iOS just open a socket. A
 * browser does not. It sends the request and then REFUSES TO HAND THE ANSWER
 * to the page unless the server said, in the response headers, that this
 * particular origin is welcome. The request already ran on the server — CORS
 * protects the reader, not the database. That is why it is not a substitute
 * for authentication and never will be.
 *
 * Two shapes of request arrive here:
 *
 *   - A simple one (a plain GET). The browser sends it, then checks the
 *     headers before revealing the body.
 *   - A preflight. Anything with an `Authorization` header or a JSON
 *     content-type — which is every single call this API takes — triggers an
 *     OPTIONS request FIRST, asking permission. Answer it or nothing works.
 *
 * The headers go on before `next()` on purpose, so a 401 or a 422 carries
 * them too. Get that wrong and the browser blanks out precisely the error
 * message the user needed to read.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;

    if (typeof origin === 'string' && isAllowed(origin, allowedOrigins)) {
      // Echo the origin back rather than answering `*`. A wildcard cannot be
      // narrowed later and cannot ever be used with credentials.
      res.setHeader('access-control-allow-origin', origin);

      // The answer differs per origin, so caches must key on it. Without this
      // a proxy can serve one origin's approval to another.
      res.setHeader('vary', 'Origin');

      // Every method the API actually answers. A method missing from this
      // list fails in the browser and nowhere else: curl and the phone app
      // never ask permission, so the bug only shows up on web.
      res.setHeader(
        'access-control-allow-methods',
        'GET, POST, PUT, DELETE, OPTIONS',
      );
      res.setHeader('access-control-allow-headers', 'authorization, content-type');

      // Remember the permission for a day instead of preflighting every call.
      res.setHeader('access-control-max-age', '86400');
    }

    // A preflight asks a question; it does not want data. Answering it here
    // means it never reaches a route, never touches the database, and never
    // needs a token — the real request that follows still does.
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.sendStatus(204);
      return;
    }

    next();
  };
}

function isAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.some((pattern) => matches(pattern, origin));
}

/**
 * Exact match, with one concession: a trailing `:*` accepts any port.
 *
 * `flutter run -d chrome` picks a fresh random port on every launch, so
 * pinning the port would mean editing configuration before each run. The
 * wildcard covers the port and nothing else — the digit check is what stops
 * `http://localhost:3000.attacker.com` from sliding through a `startsWith`.
 */
function matches(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.endsWith(':*')) return false;

  const withoutStar = pattern.slice(0, -1);

  return (
    origin.startsWith(withoutStar) &&
    /^\d+$/.test(origin.slice(withoutStar.length))
  );
}
