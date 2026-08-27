import type { Database } from '../../infrastructure/db/pool.js';
import { listGroupMembers } from '../../infrastructure/db/groups-repository.js';
import {
  insertPayment,
  listPayments,
  voidPayment,
  type PaymentRow,
} from '../../infrastructure/db/payments-repository.js';
import { badRequest, notFound } from '../../infrastructure/http/errors.js';
import { requireMembership } from '../groups/membership.js';

export interface RecordPaymentInput {
  /** Who handed the money over. Defaults to whoever is recording it. */
  readonly fromUser?: string;
  readonly toUser: string;
  readonly amountCents: number;
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
  await requireMembership(db, groupId, createdBy);

  const fromUser = input.fromUser ?? createdBy;

  if (fromUser === input.toUser) {
    throw badRequest(
      'payment_to_self',
      'a payment has to go from one person to a different one',
    );
  }

  const members = await listGroupMembers(db, groupId);
  const memberIds = new Set(members.map((member) => member.userId));

  const strangers = [fromUser, input.toUser].filter((id) => !memberIds.has(id));

  if (strangers.length > 0) {
    throw badRequest(
      'not_a_member',
      `these users are not in the group: ${[...new Set(strangers)].join(', ')}`,
    );
  }

  const payment = await insertPayment(db, {
    groupId,
    fromUser,
    toUser: input.toUser,
    amountCents: input.amountCents,
    paidAt: input.paidAt === undefined ? null : new Date(input.paidAt),
    createdBy,
  });

  return { payment };
}

export async function listGroupPayments(
  db: Database,
  groupId: string,
  userId: string,
): Promise<PaymentRow[]> {
  await requireMembership(db, groupId, userId);

  return listPayments(db, groupId);
}

export async function deletePayment(
  db: Database,
  groupId: string,
  paymentId: string,
  userId: string,
): Promise<void> {
  await requireMembership(db, groupId, userId);

  if (!(await voidPayment(db, groupId, paymentId))) {
    throw notFound('payment_not_found', 'that payment does not exist');
  }
}
