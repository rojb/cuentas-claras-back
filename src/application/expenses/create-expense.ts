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
import { requireMembership } from '../groups/membership.js';
import {
  participantsIn,
  resolveSplit,
  type SplitInput,
} from './resolve-split.js';

export interface CreateExpenseInput {
  readonly description: string;
  readonly totalCents: number;
  /** Whoever put the money down. Defaults to the person creating it. */
  readonly paidBy?: string;
  readonly spentAt?: string;
  readonly split: SplitInput;
}

export interface CreatedExpense {
  readonly expense: ExpenseRow;
  readonly shares: readonly { userId: string; shareCents: number }[];
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
  readonly shares: readonly { userId: string; shareCents: number }[];
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

  // The domain decides who owes what. It throws plain Errors because it has
  // never heard of HTTP; giving those a status code is this layer's job.
  let resolved;
  try {
    resolved = resolveSplit(input.description, input.totalCents, input.split);
  } catch (error) {
    throw unprocessable(
      'invalid_split',
      error instanceof Error ? error.message : 'the split does not add up',
    );
  }

  return {
    paidBy,
    shares: resolved.shares.map((share) => ({
      userId: share.participantId,
      shareCents: share.amountCents,
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
  const { paidBy, shares, items } = prepared;

  {
    const created = await insertExpense(tx, {
      groupId,
      description: input.description,
      totalCents: input.totalCents,
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
