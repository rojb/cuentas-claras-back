import { withTransaction, type Database } from '../../infrastructure/db/pool.js';
import { voidExpense } from '../../infrastructure/db/expenses-repository.js';
import { notFound } from '../../infrastructure/http/errors.js';
import {
  prepareExpense,
  writeExpense,
  type CreateExpenseInput,
  type CreatedExpense,
} from './create-expense.js';

/**
 * Edits an expense by voiding it and writing a new one, in one transaction.
 *
 * Not an UPDATE. This is a ledger: it stores what happened, and "what
 * happened" now includes somebody correcting a number. Voiding the old row
 * and appending the new one keeps the previous version readable — who typed
 * it, when, and what it said — which an UPDATE would overwrite and lose.
 *
 * It also means editing needs no new rules. Voiding and inserting are both
 * already written, already correct, and already the only two things that can
 * change a balance. A second mutation path would be a second place for the
 * zero-sum invariant to break.
 *
 * The price is honest and worth naming: THE EXPENSE ID CHANGES. Anybody
 * holding the old one gets a 404, exactly as if it had been deleted — which,
 * as far as the ledger is concerned, it was.
 */
export async function replaceExpense(
  db: Database,
  groupId: string,
  expenseId: string,
  actor: string,
  input: CreateExpenseInput,
): Promise<CreatedExpense> {
  // Everything that can be rejected is decided before the transaction opens,
  // so a bad split never gets as far as voiding the good expense.
  const prepared = await prepareExpense(db, groupId, actor, input);

  const expense = await withTransaction(db, async (tx) => {
    if (!(await voidExpense(tx, groupId, expenseId))) {
      // Already deleted, or never existed, or belongs to another group. The
      // membership check upstream means we can say so without leaking
      // anything: the caller is in this group either way.
      throw notFound('expense_not_found', 'that expense does not exist');
    }

    return writeExpense(tx, groupId, actor, input, prepared);
  });

  return { expense, shares: prepared.shares };
}
