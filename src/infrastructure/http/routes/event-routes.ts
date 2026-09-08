import { Router } from 'express';
import type { Database } from '../../db/pool.js';
import type { TokenSettings } from '../../../application/auth/tokens.js';
import { requireMembership } from '../../../application/groups/membership.js';
import type { GroupEvents } from '../../events/group-events.js';
import { authenticate, currentUser } from '../authenticate.js';
import { pathParams, readUuid } from '../params.js';

/**
 * GET /groups/:groupId/events — a server-sent event stream for one group.
 *
 * The app used to find out that somebody loaded an expense by being pulled
 * down. This is the same information arriving on its own.
 *
 * SSE and not WebSockets, deliberately. Everything that has to travel goes
 * one way, server to client: the client already has a perfectly good REST API
 * for saying things. A WebSocket would buy a channel back that nothing needs,
 * and cost a second protocol, its own framing, and a reconnection story that
 * browsers give away for free here — EventSource reconnects by itself.
 *
 * WHAT IS SENT IS A NUDGE, NOT DATA. The payload says "a payment landed in
 * this group", never how much or to whom. Two reasons. Pushing amounts would
 * make this a second source of truth for money, and the moment a client
 * renders a number that did not come from the ledger the two can disagree.
 * And it keeps the stream cheap: a client that missed events while its laptop
 * was shut reloads once on reconnect and is completely caught up, because the
 * nudge carries no history to replay.
 */
export function eventRoutes(
  db: Database,
  tokens: TokenSettings,
  events: GroupEvents,
): Router {
  const routes = Router({ mergeParams: true });

  // The one endpoint that takes its token from the query string.
  //
  // EventSource cannot set an Authorization header — the browser API simply
  // has no way to — so the alternatives are a token in the URL or an
  // unauthenticated stream, and an unauthenticated stream is not an option
  // for a group's private activity. See authenticate() for the cost this
  // carries and why it is confined to this route.
  routes.use(authenticate(tokens, { allowQueryToken: true }));

  routes.get('/', async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');
    const { userId } = currentUser(req);

    // Same gate as every other group-scoped route: a stream is a read, and
    // you only read what you are part of. Checked once, here, before the
    // stream opens — membership at connect time is what this stream is
    // authorised by, and somebody who leaves later stops mattering because
    // leaving requires a settled balance and they will have nothing to see.
    await requireMembership(db, groupId, userId);

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    // Nginx buffers proxied responses by default, which for a stream means
    // the events arrive in a clump whenever the buffer fills. This asks it
    // not to. Harmless anywhere else.
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    // How long the browser waits before reconnecting on its own.
    res.write('retry: 3000\n\n');
    // An immediate comment so the client knows the stream is live rather
    // than merely accepted; a stream that is quiet because nothing has
    // happened looks exactly like one that never connected.
    res.write(': open\n\n');

    const send = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const unsubscribe = events.subscribe(groupId, send);

    // Anything in the path — a proxy, a phone falling asleep, a laptop lid —
    // will close a connection that says nothing for long enough. A comment
    // every 25 seconds is cheap and keeps it open; EventSource ignores it.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    // Both, not just one: 'close' covers the client going away, and the
    // response emitting 'close' covers the server end being torn down. A
    // missed cleanup here is a listener that lives forever.
    req.on('close', close);
    res.on('close', close);
  });

  return routes;
}
