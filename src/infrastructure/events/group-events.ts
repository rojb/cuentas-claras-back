/**
 * Who is watching what, so a write can tell them it happened.
 *
 * TWO KINDS OF CHANNEL, and the difference is not cosmetic.
 *
 * A GROUP channel carries what happened inside a group, and you have to be a
 * member to open one. That covers everything the ledger does.
 *
 * A PERSON channel carries what is addressed to somebody, and an invitation
 * is the whole reason it exists: you cannot be told you were invited to a
 * group over that group's own channel, because until you accept you are not
 * allowed to open it. The invitation arrives before the membership does, so
 * it needs a channel that is about the person and not about the group.
 *
 * One Map with prefixed keys rather than two Maps: subscribing, unsubscribing
 * and the empty-set cleanup are the same three lines either way, and two
 * copies of them is two places to forget the cleanup.
 *
 * WHAT THIS IS NOT: a queue, a log, or anything the ledger depends on. The
 * facts live in Postgres and the balances are derived from them on every
 * read; this only saves the other person from having to pull down to find
 * out. If every event were dropped on the floor the app would still be
 * correct — it would just be the app it was yesterday, where you refresh by
 * hand. That is the property to protect: nothing here is allowed to become
 * load-bearing.
 *
 * IN MEMORY, AND THEREFORE SINGLE PROCESS. Two instances of this server
 * behind a load balancer would each notify their own listeners and nobody
 * else's, so somebody connected to instance A would never hear about a write
 * that landed on instance B. That is fine for how this runs — one process,
 * a handful of friends — and it is the first thing to replace (with Postgres
 * LISTEN/NOTIFY, which is already sitting right there) if it ever is not.
 */

export type GroupEventKind =
  | 'expense.created'
  | 'expense.replaced'
  | 'expense.deleted'
  | 'payment.recorded'
  | 'payment.deleted'
  | 'member.joined'
  | 'member.left'
  /** Addressed to the person invited, never to the group. */
  | 'invitation.received';

export interface GroupEvent {
  readonly kind: GroupEventKind;
  readonly groupId: string;
  /**
   * Who caused it.
   *
   * Sent so a client can ignore its own echo: whoever just recorded a payment
   * has already reloaded, and refetching because the server told them what
   * they themselves did is a wasted round trip and a flicker.
   */
  readonly actorId: string;
  readonly at: string;
}

export type GroupEventListener = (event: GroupEvent) => void;

export interface GroupEvents {
  /** Everything happening inside one group. Returns the unsubscribe. */
  subscribe(groupId: string, listener: GroupEventListener): () => void;

  /** Everything addressed to one person, wherever it comes from. */
  subscribeToPerson(userId: string, listener: GroupEventListener): () => void;

  publish(event: Omit<GroupEvent, 'at'>): void;

  /**
   * Tells ONE person something, regardless of what they are a member of.
   *
   * The event still carries a groupId — an invitation is to a group — but it
   * goes to the person's channel, because the group's would be closed to them
   * until they say yes.
   */
  publishToPerson(userId: string, event: Omit<GroupEvent, 'at'>): void;

  /** How many streams are open, for the health check and for tests. */
  listenerCount(channel?: string): number;
}

const groupChannel = (groupId: string): string => `group:${groupId}`;
const personChannel = (userId: string): string => `person:${userId}`;

export function createGroupEvents(): GroupEvents {
  const byChannel = new Map<string, Set<GroupEventListener>>();

  const listen = (
    channel: string,
    listener: GroupEventListener,
  ): (() => void) => {
    const listeners = byChannel.get(channel) ?? new Set();
    listeners.add(listener);
    byChannel.set(channel, listeners);

    return () => {
      listeners.delete(listener);
      // Channels nobody is watching do not get to keep an empty Set around.
      // Without this the map grows by one entry per group ever opened and
      // never shrinks, which is a leak that only shows up in a long run.
      if (listeners.size === 0) byChannel.delete(channel);
    };
  };

  const send = (channel: string, event: Omit<GroupEvent, 'at'>): void => {
    const listeners = byChannel.get(channel);
    if (listeners === undefined) return;

    const full: GroupEvent = { ...event, at: new Date().toISOString() };

    // A copy, because a listener that unsubscribes while being notified
    // would otherwise mutate the set we are iterating.
    for (const listener of [...listeners]) {
      try {
        listener(full);
      } catch {
        // One broken stream must not stop the others from being told, and
        // must never turn into a failed write: by the time this runs the
        // expense is already committed and the response is on its way.
      }
    }
  };

  return {
    subscribe: (groupId, listener) => listen(groupChannel(groupId), listener),
    subscribeToPerson: (userId, listener) =>
      listen(personChannel(userId), listener),

    publish: (event) => send(groupChannel(event.groupId), event),
    publishToPerson: (userId, event) => send(personChannel(userId), event),

    listenerCount(channel) {
      if (channel !== undefined) return byChannel.get(channel)?.size ?? 0;

      let total = 0;
      for (const listeners of byChannel.values()) total += listeners.size;
      return total;
    },
  };
}
