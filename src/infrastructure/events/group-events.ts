/**
 * Who is watching which group, so a write can tell them it happened.
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
  | 'member.left';

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
  /** Returns the function that stops listening. */
  subscribe(groupId: string, listener: GroupEventListener): () => void;
  publish(event: Omit<GroupEvent, 'at'>): void;
  /** How many streams are open, for the health check and for tests. */
  listenerCount(groupId?: string): number;
}

export function createGroupEvents(): GroupEvents {
  const byGroup = new Map<string, Set<GroupEventListener>>();

  return {
    subscribe(groupId, listener) {
      const listeners = byGroup.get(groupId) ?? new Set();
      listeners.add(listener);
      byGroup.set(groupId, listeners);

      return () => {
        listeners.delete(listener);
        // Groups nobody is watching do not get to keep an empty Set around.
        // Without this the map grows by one entry per group ever opened and
        // never shrinks, which is a leak that only shows up in a long run.
        if (listeners.size === 0) byGroup.delete(groupId);
      };
    },

    publish(event) {
      const listeners = byGroup.get(event.groupId);
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
    },

    listenerCount(groupId) {
      if (groupId !== undefined) return byGroup.get(groupId)?.size ?? 0;

      let total = 0;
      for (const listeners of byGroup.values()) total += listeners.size;
      return total;
    },
  };
}
