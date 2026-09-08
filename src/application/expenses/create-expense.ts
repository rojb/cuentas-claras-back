import {
  withTransaction,
  type Database,
  type Queryable,
  type Transaction,
} from '../../infrastructure/db/pool.js';
import { lockActiveGroupMembers } from '../../infrastructure/db/groups-repository.js';
import {
  insertExpense,
  insertExpenseItem,
  insertExpenseShares,
  insertItemParticipants,
  type ExpenseRow,
} from '../../infrastructure/db/expenses-repository.js';
import { badRequest, unprocessable } from '../../infrastructure/http/errors.js';
import { distributeProportionally } from '../../domain/distribute-proportionally.js';
import {
  assertRate,
  toSettlementCents,
  type CurrencyCode,
} from '../../domain/currency.js';
import { requireMembership } from '../groups/membership.js';
import {
  participantsIn,
  resolveSplit,
  type SplitInput,
} from './resolve-split.js';

export interface CreateExpenseInput {
  readonly description: string;
  /** In currencyCode. What the receipt said. */
  readonly totalCents: number;
  /** What it was paid in. A group holds expenses in several. */
  readonly currencyCode: CurrencyCode;
  /** Millionths of currencyCode per USDT, as agreed the day it was spent. */
  readonly rateMicros: number;
  /** Whoever put the money down. Defaults to the person creating it. */
  readonly paidBy?: string;
  readonly spentAt?: string;
  readonly split: SplitInput;
}

export interface CreatedExpense {
  readonly expense: ExpenseRow;
  readonly shares: readonly {
    userId: string;
    shareCents: number;
    shareUsdtCents: number;
  }[];
}

/**
 * The database spells its strategies the way SQL reads; the API spells them
 * the way JSON reads. Neither has to give in, they just meet here.
 */
const STRATEGY_IN_DATABASE: Record<string, string> = {
  equally: 'equally',
  exactAmounts: 'exact_amounts',
  percentages: 'percentages',
  shares: 'shares',
  mixed: 'mixed',
  items: 'items',
  proportionalToConsumption: 'proportional_to_consumption',
};

export async function createExpense(
  db: Database,
  groupId: string,
  createdBy: string,
  input: CreateExpenseInput,
): Promise<CreatedExpense> {
  return withTransaction(db, async (tx) => {
    const prepared = await prepareExpense(tx, groupId, createdBy, input);
    const expense = await writeExpense(tx, groupId, createdBy, input, prepared);

    return { expense, shares: prepared.shares };
  });
}

export interface PreparedExpense {
  readonly paidBy: string;
  /** The total, converted once, in the unit the ledger settles in. */
  readonly totalUsdtCents: number;
  readonly shares: readonly {
    userId: string;
    /** What they agreed to, in the expense's currency. */
    shareCents: number;
    /** What the ledger charges them. Adds up to totalUsdtCents exactly. */
    shareUsdtCents: number;
  }[];
  readonly items: ReturnType<typeof resolveSplit>['items'];
}

/**
 * Everything that can be rejected, decided before a single row is written.
 *
 * Separated from the writing so that editing an expense — which is a void
 * plus a fresh insert — can reuse the exact same rules without duplicating
 * them.
 *
 * MUST run inside the caller's transaction, which is why it takes a Queryable
 * and not a Pool. It does not merely read who the members are, it LOCKS them
 * (see assertEveryoneIsAMember), and a lock taken on a pooled connection that
 * is handed back a millisecond later is not a lock at all — it is a comment.
 */
export async function prepareExpense(
  db: Queryable,
  groupId: string,
  actor: string,
  input: CreateExpenseInput,
): Promise<PreparedExpense> {
  await requireMembership(db, groupId, actor);

  const paidBy = input.paidBy ?? actor;

  await assertEveryoneIsAMember(db, groupId, [
    paidBy,
    ...participantsIn(input.split),
  ]);

  // The rate is checked before anything is divided, so that a typo in it
  // fails as a rate problem and not as a mysterious split that will not add
  // up three steps later.
  try {
    assertRate(input.currencyCode, input.rateMicros);
  } catch (error) {
    throw unprocessable(
      'invalid_rate',
      error instanceof Error ? error.message : 'that exchange rate is not usable',
    );
  }

  const totalUsdtCents = toSettlementCents(input.totalCents, input.rateMicros);

  // Small change can be worth less than a cent of USDT. There is no honest
  // way to put that in a ledger denominated in USDT cents: rounding it up
  // invents money, and rounding it down charges people for nothing.
  if (totalUsdtCents <= 0) {
    throw unprocessable(
      'amount_too_small',
      `${input.totalCents} ${input.currencyCode} cents is worth less than a ` +
        `cent of USDT at that rate`,
    );
  }

  // The domain decides who owes what. It throws plain Errors because it has
  // never heard of HTTP; giving those a status code is this layer's job.
  //
  // NOTE THE ORDER: the split is resolved in the currency the money was
  // actually spent in. "Ana pone Bs 40" is what the people agreed to, and it
  // is what has to add up to the Bs 100 on the receipt.
  let resolved;
  try {
    resolved = resolveSplit(input.description, input.totalCents, input.split);
  } catch (error) {
    throw unprocessable(
      'invalid_split',
      error instanceof Error ? error.message : 'the split does not add up',
    );
  }

  // And only now, once, on the total.
  //
  // The shares in the original currency become WEIGHTS, and the converted
  // total is divided by the same largest-remainder engine every other split
  // already uses. Converting each share on its own instead would round each
  // one on its own, and a handful of separate roundings do not add back up
  // to the converted total — which is exactly the invariant the database
  // refuses to commit without.
  const usdtShares = distributeProportionally(
    totalUsdtCents,
    resolved.shares.map((share) => share.amountCents),
  );

  return {
    paidBy,
    totalUsdtCents,
    shares: resolved.shares.map((share, index) => ({
      userId: share.participantId,
      shareCents: share.amountCents,
      shareUsdtCents: usdtShares[index] ?? 0,
    })),
    items: resolved.items,
  };
}

/** The rows, and nothing else. Runs inside a caller's transaction. */
export async function writeExpense(
  tx: Transaction,
  groupId: string,
  createdBy: string,
  input: CreateExpenseInput,
  prepared: PreparedExpense,
): Promise<ExpenseRow> {
  const { paidBy, totalUsdtCents, shares, items } = prepared;

  {
    const created = await insertExpense(tx, {
      groupId,
      description: input.description,
      totalCents: input.totalCents,
      currencyCode: input.currencyCode,
      rateMicros: input.rateMicros,
      totalUsdtCents,
      paidBy,
      splitStrategy: STRATEGY_IN_DATABASE[input.split.kind] ?? input.split.kind,
      // Kept verbatim for audit and editing: what the user asked for, not
      // what it resolved to. expense_shares is the source of truth for debts.
      splitParams: input.split,
      spentAt: input.spentAt === undefined ? null : new Date(input.spentAt),
      createdBy,
    });

    await insertExpenseShares(tx, created.id, groupId, shares);

    if (items !== null) {
      for (const [position, item] of items.entries()) {
        const itemId = await insertExpenseItem(tx, {
          expenseId: created.id,
          groupId,
          position,
          description: item.description,
          amountCents: item.amountCents,
          splitStrategy:
            STRATEGY_IN_DATABASE[item.split.kind] ?? item.split.kind,
          splitParams: item.split,
        });

        await insertItemParticipants(tx, itemId, groupId, item.participants);
      }
    }

    return created;
  }
}

/**
 * The composite foreign key on (group_id, user_id) already stops us charging
 * a complete stranger, but it does so as a raw driver error at COMMIT, naming
 * a constraint instead of a person. Checking here buys a message the client
 * can act on.
 *
 * For somebody who LEFT the group, this check is not a nicety — it is the
 * only thing standing in the way. Their membership row is still there, on
 * purpose, holding up the expenses they were part of, so the foreign key
 * still says yes.
 *
 * Which is why this LOCKS as it reads. Somebody may only leave a group at a
 * balance of zero (see leave-group.ts), and that rule is worth exactly as
 * much as the guarantee that no expense lands on them between the moment
 * their balance was read and the moment they are gone. Holding these rows
 * makes the two operations take turns: the goodbye waits for this expense and
 * then sees a balance that includes it, or this expense waits for the goodbye
 * and then finds the person is no longer a member. Either order is correct.
 * No order at all is how a debt ends up belonging to nobody.
 */
async function assertEveryoneIsAMember(
  db: Queryable,
  groupId: string,
  userIds: readonly string[],
): Promise<void> {
  const memberIds = await lockActiveGroupMembers(db, groupId, userIds);

  const strangers = [...new Set(userIds)].filter((id) => !memberIds.has(id));

  if (strangers.length > 0) {
    throw badRequest(
      'not_a_member',
      `these users are not in the group: ${strangers.join(', ')}`,
    );
  }
}
