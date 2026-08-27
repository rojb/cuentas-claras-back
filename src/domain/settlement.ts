import {
  assertBalancesAddUpToZero,
  creditorsOf,
  debtorsOf,
  type Balance,
} from './balances.js';
import type { ParticipantId } from './split-by-items.js';

/** One transfer somebody still has to make for the group to be square. */
export interface Transfer {
  readonly fromParticipant: ParticipantId;
  readonly toParticipant: ParticipantId;
  readonly amountCents: number;
}

/**
 * Turns balances into the transfers that settle the group.
 *
 * Nobody cares that "Beto owes the group $15.64" — they need to know who to
 * send money to. And they should not have to make five transfers when one
 * is enough.
 *
 * The rule is greedy: take whoever owes the most and whoever is owed the
 * most, and move as much as possible between them in one go. Whichever of
 * the two reaches zero drops out, and we repeat. Because every step settles
 * at least one person for good, a group of N people never needs more than
 * N-1 transfers.
 *
 * This is NOT guaranteed to be the theoretical minimum — finding that is an
 * NP-hard problem, and paying an exponential cost to occasionally save one
 * transfer between friends is a bad trade. In practice this collapses the
 * usual tangle of debts down to a handful of payments.
 *
 * @param balances Balances of the group, as returned by calculateBalances.
 * @returns The transfers to make, largest debt first. Empty if all settled.
 */
export function settle(balances: readonly Balance[]): Transfer[] {
  assertBalancesAddUpToZero(balances);

  // Working copies, as positive amounts: what is still left to move.
  const owing = debtorsOf(balances).map((balance) => ({
    participantId: balance.participantId,
    remainingCents: -balance.balanceCents,
  }));

  const owed = creditorsOf(balances).map((balance) => ({
    participantId: balance.participantId,
    remainingCents: balance.balanceCents,
  }));

  const transfers: Transfer[] = [];

  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < owing.length && creditorIndex < owed.length) {
    const debtor = owing[debtorIndex];
    const creditor = owed[creditorIndex];

    if (debtor === undefined || creditor === undefined) {
      break;
    }

    const amountCents = Math.min(debtor.remainingCents, creditor.remainingCents);

    // Cannot happen: both lists only hold non-zero amounts. Guarded anyway,
    // because a zero here would loop forever.
    if (amountCents <= 0) {
      break;
    }

    transfers.push({
      fromParticipant: debtor.participantId,
      toParticipant: creditor.participantId,
      amountCents,
    });

    debtor.remainingCents -= amountCents;
    creditor.remainingCents -= amountCents;

    if (debtor.remainingCents === 0) {
      debtorIndex += 1;
    }
    if (creditor.remainingCents === 0) {
      creditorIndex += 1;
    }
  }

  assertTransfersSettleEveryone(balances, transfers);

  return transfers;
}

/**
 * Making every one of these transfers must leave the whole group at zero.
 * If it does not, the plan is wrong and would leave people short.
 */
function assertTransfersSettleEveryone(
  balances: readonly Balance[],
  transfers: readonly Transfer[],
): void {
  const remaining = new Map<ParticipantId, number>(
    balances.map((balance) => [balance.participantId, balance.balanceCents]),
  );

  const apply = (participantId: ParticipantId, deltaCents: number): void => {
    remaining.set(participantId, (remaining.get(participantId) ?? 0) + deltaCents);
  };

  for (const transfer of transfers) {
    apply(transfer.fromParticipant, transfer.amountCents);
    apply(transfer.toParticipant, -transfer.amountCents);
  }

  for (const [participantId, balanceCents] of remaining) {
    if (balanceCents !== 0) {
      throw new Error(
        `settlement is wrong: ${participantId} would still be at ` +
          `${balanceCents} cents after making every transfer`,
      );
    }
  }
}
