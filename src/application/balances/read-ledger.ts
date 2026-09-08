import type { Queryable } from '../../infrastructure/db/pool.js';
import {
  listExpenses,
  listShares,
} from '../../infrastructure/db/expenses-repository.js';
import { listPayments } from '../../infrastructure/db/payments-repository.js';
import { listGroupMembers } from '../../infrastructure/db/groups-repository.js';
import {
  calculateBalances,
  type Balance,
  type ExpenseRecord,
  type PaymentRecord,
} from '../../domain/balances.js';
import { settle, type Transfer } from '../../domain/settlement.js';
import { requireMembership } from '../groups/membership.js';

/**
 * Where everyone in a group stands.
 *
 * Nothing is read from a debts table, because there is no debts table. The
 * only two things ever written down are expenses and payments; this reads
 * both and hands them to the domain, which does the arithmetic.
 *
 * That is also why "was this debt paid in full or in part?" needs no code
 * anywhere: a partial payment is just a transfer for less than what was
 * owed, and the balance that comes back already says what is left.
 *
 * Takes a Queryable, not a Pool, so that a caller who needs these numbers to
 * still be true by the time it writes something — leaving a group is the one
 * that does — can read them inside its own transaction.
 */
export async function calculateGroupBalances(
  db: Queryable,
  groupId: string,
  userId: string,
): Promise<Balance[]> {
  await requireMembership(db, groupId, userId);

  const [members, expenses, shares, payments] = await Promise.all([
    listGroupMembers(db, groupId),
    listExpenses(db, groupId),
    listShares(db, groupId),
    listPayments(db, groupId),
  ]);

  // EVERYTHING BELOW IS IN USDT, and nothing else gets in.
  //
  // The group holds expenses in bolivianos, dollars and USDT, but a balance
  // made of three currencies is not a balance — you cannot subtract Bs 40
  // from 12 USD and get a number that means anything. Each expense was
  // converted once, when it was written, at the rate agreed that day; this is
  // where those already-converted amounts are read and nothing is converted
  // again. The domain never learns that more than one currency exists.
  const sharesByExpense = new Map<string, { participantId: string; amountCents: number }[]>();

  for (const share of shares) {
    const forExpense = sharesByExpense.get(share.expenseId) ?? [];
    forExpense.push({
      participantId: share.userId,
      amountCents: share.shareUsdtCents,
    });
    sharesByExpense.set(share.expenseId, forExpense);
  }

  const expenseRecords: ExpenseRecord[] = expenses.map((expense) => ({
    id: expense.id,
    paidBy: expense.paidBy,
    totalCents: expense.totalUsdtCents,
    shares: sharesByExpense.get(expense.id) ?? [],
  }));

  const paymentRecords: PaymentRecord[] = payments.map((payment) => ({
    id: payment.id,
    fromParticipant: payment.fromUser,
    toParticipant: payment.toUser,
    amountCents: payment.amountUsdtCents,
  }));

  const balances = calculateBalances(expenseRecords, paymentRecords);

  // The domain only knows about people who appear in the ledger. A member who
  // has not spent or paid anything yet is still a member, and the app has to
  // be able to draw them at zero instead of leaving a hole in the list.
  const seen = new Set(balances.map((balance) => balance.participantId));

  return [
    ...balances,
    ...members
      .filter((member) => !seen.has(member.userId))
      .map((member) => ({ participantId: member.userId, balanceCents: 0 })),
  ];
}

/** Who should pay whom, and how much, to leave the group square. */
export async function calculateGroupSettlement(
  db: Queryable,
  groupId: string,
  userId: string,
): Promise<Transfer[]> {
  return settle(await calculateGroupBalances(db, groupId, userId));
}
