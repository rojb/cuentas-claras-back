import { assertAmountCents, sumIntegers } from './money.js';
import type { ParticipantId, ParticipantShare } from './split-by-items.js';

/**
 * An expense that already happened: somebody paid for something, and the
 * split was already resolved into cents per participant.
 *
 * The shares are stored, not recomputed. They are the historical fact — if
 * we ever change a rounding rule, past expenses must not silently change
 * how much money people owed each other.
 */
export interface ExpenseRecord {
  readonly id: string;
  readonly paidBy: ParticipantId;
  readonly totalCents: number;
  readonly shares: readonly ParticipantShare[];
}

/**
 * Money actually handed over to settle up: a transfer from one person to
 * another. A partial payment is not a special case — it is simply a
 * transfer for less than what was owed.
 */
export interface PaymentRecord {
  readonly id: string;
  readonly fromParticipant: ParticipantId;
  readonly toParticipant: ParticipantId;
  readonly amountCents: number;
}

/**
 * How a person stands in the group.
 *
 *   positive -> the group owes them money (they put in more than their share)
 *   negative -> they owe the group money
 *   zero     -> settled up
 */
export interface Balance {
  readonly participantId: ParticipantId;
  readonly balanceCents: number;
}

/**
 * Works out where everyone stands, from the only two things that are ever
 * stored: the expenses and the payments.
 *
 * Nothing here is read from a "debt" table, because a debt is not a fact —
 * it is a result. It changes on its own every time a new expense lands, and
 * a stored copy of it would start lying the moment that happens.
 *
 * For every expense: whoever paid gets credited the full amount, and every
 * participant gets charged their share. For every payment: the sender's
 * debt goes down and the receiver's credit goes down by the same amount.
 *
 * @param expenses Every expense of the group.
 * @param payments Every settle-up transfer of the group.
 * @returns One balance per person, in the order they first appear. Always
 *          adds up to exactly zero.
 */
export function calculateBalances(
  expenses: readonly ExpenseRecord[],
  payments: readonly PaymentRecord[],
): Balance[] {
  expenses.forEach((expense, index) =>
    assertValidExpense(expense, `expenses[${index}]`),
  );
  payments.forEach((payment, index) =>
    assertValidPayment(payment, `payments[${index}]`),
  );

  const balanceByParticipant = new Map<ParticipantId, number>();
  const orderOfAppearance: ParticipantId[] = [];

  const adjust = (participantId: ParticipantId, deltaCents: number): void => {
    if (!balanceByParticipant.has(participantId)) {
      balanceByParticipant.set(participantId, 0);
      orderOfAppearance.push(participantId);
    }
    const current = balanceByParticipant.get(participantId) ?? 0;
    balanceByParticipant.set(participantId, current + deltaCents);
  };

  for (const expense of expenses) {
    // Whoever paid fronted the whole bill, so the group owes them that much.
    adjust(expense.paidBy, expense.totalCents);

    // And everyone who took part owes their share of it.
    for (const share of expense.shares) {
      adjust(share.participantId, -share.amountCents);
    }
  }

  for (const payment of payments) {
    // Handing money over reduces what you owe...
    adjust(payment.fromParticipant, payment.amountCents);
    // ...and reduces what the other person is still owed.
    adjust(payment.toParticipant, -payment.amountCents);
  }

  const balances = orderOfAppearance.map((participantId) => ({
    participantId,
    balanceCents: balanceByParticipant.get(participantId) ?? 0,
  }));

  assertBalancesAddUpToZero(balances);

  return balances;
}

/** Everyone who is owed money, most owed first. */
export function creditorsOf(balances: readonly Balance[]): Balance[] {
  return balances
    .filter((balance) => balance.balanceCents > 0)
    .sort((a, b) => b.balanceCents - a.balanceCents || compareIds(a, b));
}

/** Everyone who owes money, deepest in debt first. */
export function debtorsOf(balances: readonly Balance[]): Balance[] {
  return balances
    .filter((balance) => balance.balanceCents < 0)
    .sort((a, b) => a.balanceCents - b.balanceCents || compareIds(a, b));
}

function compareIds(a: Balance, b: Balance): number {
  return a.participantId.localeCompare(b.participantId);
}

/**
 * THE INVARIANT.
 *
 * Every cent that leaves someone's pocket lands in someone else's, so the
 * balances of a group must cancel out exactly. If this ever fires, the bug
 * is upstream and the ledger is not to be trusted: better a loud crash than
 * quietly telling people the wrong amount.
 */
export function assertBalancesAddUpToZero(balances: readonly Balance[]): void {
  const total = sumIntegers(balances.map((balance) => balance.balanceCents));

  if (total !== 0) {
    throw new Error(
      `balances must add up to zero but add up to ${total} cents: ` +
        `the ledger is inconsistent`,
    );
  }
}

function assertValidExpense(expense: ExpenseRecord, label: string): void {
  assertAmountCents(expense.totalCents, `${label}.totalCents`);

  if (expense.shares.length === 0) {
    throw new Error(`${label} must have at least one share`);
  }

  const distinct = new Set(expense.shares.map((share) => share.participantId));
  if (distinct.size !== expense.shares.length) {
    throw new Error(
      `${label} charges the same participant more than once`,
    );
  }

  expense.shares.forEach((share, index) =>
    assertAmountCents(share.amountCents, `${label}.shares[${index}].amountCents`),
  );

  const assigned = sumIntegers(expense.shares.map((share) => share.amountCents));

  if (assigned !== expense.totalCents) {
    throw new Error(
      `${label}: shares add up to ${assigned} but totalCents is ` +
        `${expense.totalCents}`,
    );
  }
}

function assertValidPayment(payment: PaymentRecord, label: string): void {
  assertAmountCents(payment.amountCents, `${label}.amountCents`);

  if (payment.amountCents === 0) {
    throw new Error(`${label}.amountCents must be greater than zero`);
  }

  if (payment.fromParticipant === payment.toParticipant) {
    throw new Error(`${label} cannot be a payment from someone to themselves`);
  }
}
