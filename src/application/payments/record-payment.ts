import { withTransaction, type Database } from '../../infrastructure/db/pool.js';
import { lockActiveGroupMembers } from '../../infrastructure/db/groups-repository.js';
import {
  findPayment,
  insertPayment,
  listPaymentHistory,
  voidPayment,
  type PaymentRow,
} from '../../infrastructure/db/payments-repository.js';
import {
  badRequest,
  forbidden,
  notFound,
  unprocessable,
} from '../../infrastructure/http/errors.js';
import {
  assertRate,
  toSettlementCents,
  type CurrencyCode,
} from '../../domain/currency.js';
import { requireMembership } from '../groups/membership.js';

export interface RecordPaymentInput {
  /** Who handed the money over. Defaults to whoever is recording it. */
  readonly fromUser?: string;
  readonly toUser: string;
  /** In currencyCode. */
  readonly amountCents: number;
  /**
   * What was actually handed over.
   *
   * A debt is in USDT, but nobody is obliged to settle it in USDT: handing
   * somebody Bs 348 to cover 50 USDT is a normal thing to do, and the rate
   * agreed that day is what says the two are the same payment.
   */
  readonly currencyCode: CurrencyCode;
  readonly rateMicros: number;
  readonly paidAt?: string;
}

/**
 * Writes down that money actually changed hands.
 *
 * This is the whole of "register when a debt was paid". There is no debt to
 * look up and mark as settled, no status to move from pending to paid, and
 * no separate case for a partial payment: paying half is recording half.
 * The balance recomputes and says what is left, because it always did.
 *
 * Note what is NOT validated: that the amount is at most what was owed.
 * Overpaying is a real thing people do, and the honest answer is a balance
 * that flips sign — not a refusal. The moment we reject it, we are treating
 * a derived number as if it were a fact again.
 */
export async function recordPayment(
  db: Database,
  groupId: string,
  createdBy: string,
  input: RecordPaymentInput,
): Promise<{ payment: PaymentRow }> {
  const fromUser = input.fromUser ?? createdBy;

  if (fromUser === input.toUser) {
    throw badRequest(
      'payment_to_self',
      'a payment has to go from one person to a different one',
    );
  }

  try {
    assertRate(input.currencyCode, input.rateMicros);
  } catch (error) {
    throw unprocessable(
      'invalid_rate',
      error instanceof Error ? error.message : 'that exchange rate is not usable',
    );
  }

  const amountUsdtCents = toSettlementCents(input.amountCents, input.rateMicros);

  if (amountUsdtCents <= 0) {
    throw unprocessable(
      'amount_too_small',
      `${input.amountCents} ${input.currencyCode} cents is worth less than a ` +
        `cent of USDT at that rate`,
    );
  }

  // One transaction for a single INSERT, which looks like overkill until you
  // remember what the check above it does: it locks the two memberships, and
  // that lock is what stops a payment from landing on somebody who is walking
  // out the door at the same instant. Same reasoning as create-expense.ts.
  return withTransaction(db, async (tx) => {
    const group = await requireMembership(tx, groupId, createdBy);

    // WHO IS ALLOWED TO WRITE THIS DOWN.
    //
    // Anybody the payment is ABOUT, plus whoever created the group.
    //
    // Both ends of it, not just the payer: the person receiving the money is
    // the one who actually knows it arrived, and "ya me pagó, lo anoto" is
    // how this gets used more often than not. What stays out is the fourth
    // member of the group leaving notes about two other people's business,
    // because recording a payment moves somebody else's balance.
    //
    // 403 and not 404 here, unlike requireMembership: they are a member, they
    // can already see this group, and there is nothing left to hide. The only
    // thing being refused is the write.
    if (
      createdBy !== fromUser &&
      createdBy !== input.toUser &&
      createdBy !== group.createdBy
    ) {
      throw forbidden(
        'cannot_record_payment',
        'only the two people this payment is between, or whoever created ' +
          'the group, can record it',
      );
    }

    const memberIds = await lockActiveGroupMembers(tx, groupId, [
      fromUser,
      input.toUser,
    ]);

    const strangers = [fromUser, input.toUser].filter(
      (id) => !memberIds.has(id),
    );

    if (strangers.length > 0) {
      throw badRequest(
        'not_a_member',
        `these users are not in the group: ${[...new Set(strangers)].join(', ')}`,
      );
    }

    const payment = await insertPayment(tx, {
      groupId,
      fromUser,
      toUser: input.toUser,
      amountCents: input.amountCents,
      currencyCode: input.currencyCode,
      rateMicros: input.rateMicros,
      amountUsdtCents,
      paidAt: input.paidAt === undefined ? null : new Date(input.paidAt),
      createdBy,
    });

    return { payment };
  });
}

/**
 * The group's payment history, VOIDED ONES INCLUDED.
 *
 * Not the same list the balances are built from. A voided payment stops
 * counting and stays visible: the history is a record of what people did, and
 * one you can quietly take things out of is not a record. The rows come back
 * carrying voidedAt so the screen can strike them through instead of drawing
 * them as if they still moved money.
 */
export async function listGroupPayments(
  db: Database,
  groupId: string,
  userId: string,
): Promise<PaymentRow[]> {
  await requireMembership(db, groupId, userId);

  return listPaymentHistory(db, groupId);
}

/**
 * Strikes a payment through.
 *
 * Same rule as writing one, plus whoever wrote it: both ends of the payment,
 * the person who recorded it, and whoever created the group.
 *
 * The recorder is on the list even when the money was not theirs, because the
 * most common reason to delete a payment is that the person typing it made a
 * mistake, and having to go and find the host to fix a typo is how a ledger
 * ends up with corrections nobody bothered to make.
 */
export async function deletePayment(
  db: Database,
  groupId: string,
  paymentId: string,
  userId: string,
): Promise<void> {
  const group = await requireMembership(db, groupId, userId);

  // Read before deleting: who may strike this through depends on who wrote
  // it and who paid, and neither is knowable from the id.
  const payment = await findPayment(db, groupId, paymentId);

  if (payment === null) {
    throw notFound('payment_not_found', 'that payment does not exist');
  }

  if (
    userId !== payment.createdBy &&
    userId !== payment.fromUser &&
    userId !== payment.toUser &&
    userId !== group.createdBy
  ) {
    throw forbidden(
      'cannot_delete_payment',
      'only the two people this payment is between, the person who recorded ' +
        'it, or whoever created the group can delete it',
    );
  }

  if (!(await voidPayment(db, groupId, paymentId, userId))) {
    throw notFound('payment_not_found', 'that payment does not exist');
  }
}
