import {
  splitByItems,
  sumItemAmounts,
  type ExpenseItem,
  type ParticipantShare,
} from '../../domain/split-by-items.js';
import { REST, exactly } from '../../domain/split-mixed.js';

/**
 * How a split arrives over HTTP.
 *
 * The domain works positionally: percentages[0] belongs to participants[0].
 * That is right for pure arithmetic and wrong for a public API — two lists
 * the client has to keep aligned is a silent-wrong-person bug waiting to
 * happen. So over the wire every number travels attached to its owner, and
 * this file is the only place where by-name becomes by-position.
 */
export type SplitInput =
  | { readonly kind: 'equally'; readonly participants: readonly string[] }
  | {
      readonly kind: 'exactAmounts';
      readonly participants: readonly { userId: string; amountCents: number }[];
    }
  | {
      readonly kind: 'percentages';
      readonly participants: readonly {
        userId: string;
        percentageBasisPoints: number;
      }[];
    }
  | {
      readonly kind: 'shares';
      readonly participants: readonly { userId: string; shares: number }[];
    }
  /** A participant with no amountCents is one of the ones splitting the rest. */
  | {
      readonly kind: 'mixed';
      readonly participants: readonly { userId: string; amountCents?: number }[];
    }
  | { readonly kind: 'items'; readonly items: readonly ItemInput[] };

/** An item cannot itself be made of items, but it can be a surcharge. */
export type ItemSplitInput =
  | Exclude<SplitInput, { kind: 'items' }>
  | {
      readonly kind: 'proportionalToConsumption';
      readonly participants: readonly string[];
    };

export interface ItemInput {
  readonly description: string;
  readonly amountCents: number;
  readonly split: ItemSplitInput;
}

export interface ResolvedSplit {
  readonly shares: readonly ParticipantShare[];
  /** null for a plain expense; the resolved lines for an itemised one. */
  readonly items: readonly ExpenseItem[] | null;
}

/**
 * Turns the requested split into what each person owes, in cents.
 *
 * A plain expense is treated as an itemised one with a single line. That is
 * not a trick to save code — it is the same statement the domain already
 * makes: an item IS a small expense. One code path means a percentage split
 * cannot round differently depending on whether it arrived alone or as part
 * of a bill.
 *
 * Throws plain Errors from the domain when the numbers do not work out. The
 * caller is responsible for turning those into an HTTP status; the domain
 * has never heard of HTTP and it is going to stay that way.
 */
export function resolveSplit(
  description: string,
  totalCents: number,
  split: SplitInput,
): ResolvedSplit {
  if (split.kind !== 'items') {
    try {
      return {
        shares: splitByItems([toDomainItem(description, totalCents, split)]),
        items: null,
      };
    } catch (error) {
      throw asPlainSplitError(error);
    }
  }

  const items = split.items.map((item) =>
    toDomainItem(item.description, item.amountCents, item.split),
  );

  const addedUp = sumItemAmounts(items);
  if (addedUp !== totalCents) {
    throw new Error(
      `the items add up to ${addedUp} cents but the expense total is ${totalCents} cents`,
    );
  }

  return { shares: splitByItems(items), items };
}

/**
 * Wrapping a plain expense in a single item is our idea, not the client's.
 * The domain quite reasonably labels its complaints `items[0]`, and a client
 * that never mentioned items should never be told about them.
 */
function asPlainSplitError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  return new Error(
    error.message
      .replace(/^items\[0\]\./, '')
      .replace(/^items\[0\] /, 'the split ')
      .replace(/\bthe item\b/g, 'the expense'),
  );
}

/** Everybody named anywhere in a split, without repeats. */
export function participantsIn(split: SplitInput): string[] {
  const named =
    split.kind === 'items'
      ? split.items.flatMap((item) => participantsInItemSplit(item.split))
      : participantsInItemSplit(split);

  return [...new Set(named)];
}

function participantsInItemSplit(split: ItemSplitInput): string[] {
  if (split.kind === 'equally' || split.kind === 'proportionalToConsumption') {
    return [...split.participants];
  }

  return split.participants.map((participant) => participant.userId);
}

function toDomainItem(
  description: string,
  amountCents: number,
  split: ItemSplitInput,
): ExpenseItem {
  switch (split.kind) {
    case 'equally':
      return {
        description,
        amountCents,
        participants: [...split.participants],
        split: { kind: 'equally' },
      };

    case 'proportionalToConsumption':
      return {
        description,
        amountCents,
        participants: [...split.participants],
        split: { kind: 'proportionalToConsumption' },
      };

    case 'exactAmounts':
      return {
        description,
        amountCents,
        participants: split.participants.map((participant) => participant.userId),
        split: {
          kind: 'exactAmounts',
          amountsCents: split.participants.map(
            (participant) => participant.amountCents,
          ),
        },
      };

    case 'percentages':
      return {
        description,
        amountCents,
        participants: split.participants.map((participant) => participant.userId),
        split: {
          kind: 'percentages',
          percentagesBasisPoints: split.participants.map(
            (participant) => participant.percentageBasisPoints,
          ),
        },
      };

    case 'shares':
      return {
        description,
        amountCents,
        participants: split.participants.map((participant) => participant.userId),
        split: {
          kind: 'shares',
          shares: split.participants.map((participant) => participant.shares),
        },
      };

    case 'mixed':
      return {
        description,
        amountCents,
        participants: split.participants.map((participant) => participant.userId),
        split: {
          kind: 'mixed',
          parts: split.participants.map((participant) =>
            participant.amountCents === undefined
              ? REST
              : exactly(participant.amountCents),
          ),
        },
      };
  }
}
