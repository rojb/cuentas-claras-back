import type { Database } from '../../infrastructure/db/pool.js';
import {
  findExpense,
  listExpenses,
  listShares,
  listSharesOf,
  voidExpense,
  type ExpenseRow,
} from '../../infrastructure/db/expenses-repository.js';
import { notFound } from '../../infrastructure/http/errors.js';
import { requireMembership } from '../groups/membership.js';

/**
 * An expense and what each person owes for it, in BOTH units.
 *
 * shareCents is what the people agreed to, in the currency the money was
 * spent in: it is the number that has to look right next to the receipt.
 * shareUsdtCents is what the ledger actually charges them, and it is the one
 * the balances are built from. Sending only the first would leave the client
 * unable to explain its own totals; sending only the second would show
 * somebody "4,79" for a lunch they remember paying Bs 33,34 for.
 */
export interface ExpenseWithShares {
  readonly expense: ExpenseRow;
  readonly shares: readonly {
    userId: string;
    shareCents: number;
    shareUsdtCents: number;
  }[];
}

/**
 * Every expense of a group, each with its shares.
 *
 * Two queries, not one per expense. A join would bring the same expense back
 * once per participant and leave the stitching to us anyway; this way the
 * cost does not grow with the number of expenses on screen.
 */
export async function listGroupExpenses(
  db: Database,
  groupId: string,
  userId: string,
): Promise<ExpenseWithShares[]> {
  await requireMembership(db, groupId, userId);

  const [expenses, shares] = await Promise.all([
    listExpenses(db, groupId),
    listShares(db, groupId),
  ]);

  const sharesByExpense = new Map<
    string,
    { userId: string; shareCents: number; shareUsdtCents: number }[]
  >();

  for (const share of shares) {
    const forExpense = sharesByExpense.get(share.expenseId) ?? [];
    forExpense.push({
      userId: share.userId,
      shareCents: share.shareCents,
      shareUsdtCents: share.shareUsdtCents,
    });
    sharesByExpense.set(share.expenseId, forExpense);
  }

  return expenses.map((expense) => ({
    expense,
    shares: sharesByExpense.get(expense.id) ?? [],
  }));
}

export async function getExpense(
  db: Database,
  groupId: string,
  expenseId: string,
  userId: string,
): Promise<ExpenseWithShares> {
  await requireMembership(db, groupId, userId);

  const expense = await findExpense(db, groupId, expenseId);

  if (expense === null) {
    throw notFound('expense_not_found', 'that expense does not exist');
  }

  const shares = await listSharesOf(db, expenseId);

  return {
    expense,
    shares: shares.map((share) => ({
      userId: share.userId,
      shareCents: share.shareCents,
      shareUsdtCents: share.shareUsdtCents,
    })),
  };
}

/**
 * Voids an expense. The row survives with a deleted_at stamp, and every
 * balance recomputes without it — which is the whole point of never having
 * stored a balance in the first place.
 */
export async function deleteExpense(
  db: Database,
  groupId: string,
  expenseId: string,
  userId: string,
): Promise<void> {
  await requireMembership(db, groupId, userId);

  if (!(await voidExpense(db, groupId, expenseId))) {
    throw notFound('expense_not_found', 'that expense does not exist');
  }
}
