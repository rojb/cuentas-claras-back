import { withTransaction, type Database } from '../../infrastructure/db/pool.js';
import {
  lockActiveGroupMember,
  markGroupMemberAsLeft,
} from '../../infrastructure/db/groups-repository.js';
import { conflict, notFound } from '../../infrastructure/http/errors.js';
import { calculateGroupBalances } from '../balances/read-ledger.js';

/**
 * Leaving a group.
 *
 * Who may do this: you, to yourself. Removing somebody else is a different
 * feature and needs a permission model this app deliberately does not have —
 * see the note in add-group-member.ts.
 *
 * THE RULE: you can only leave at zero.
 *
 * This is the whole point of the use case, and it is not a formality. The
 * balances of a group must add up to exactly zero — the domain asserts it on
 * every read. Letting somebody walk out owing 3.000 pesos would not delete
 * that debt, it would orphan it: the money is still missing from the group,
 * the settlement still tries to route a transfer to a person who is gone, and
 * the numbers stop meaning anything. Being square is what makes leaving a
 * safe operation instead of a hole in the ledger.
 *
 * "Settle up first" is also the honest answer to give a user. There is no
 * amount of software design that makes an unpaid debt disappear.
 */
export async function leaveGroup(
  db: Database,
  groupId: string,
  userId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    // Read the membership and hold it, so the balance we are about to trust
    // cannot move under us while we decide. See lockActiveGroupMember().
    if (!(await lockActiveGroupMember(tx, groupId, userId))) {
      // Same answer requireMembership() gives: a group that is not yours is,
      // as far as you are concerned, a group that does not exist.
      throw notFound('group_not_found', 'that group does not exist');
    }

    const balances = await calculateGroupBalances(tx, groupId, userId);
    const mine = balances.find((balance) => balance.participantId === userId);

    // Nobody in the ledger yet means nothing owed either way.
    const balanceCents = mine?.balanceCents ?? 0;

    if (balanceCents !== 0) {
      throw conflict(
        'balance_not_settled',
        balanceCents < 0
          ? `you still owe ${-balanceCents} cents in this group: settle up before leaving`
          : `this group still owes you ${balanceCents} cents: get paid back before leaving`,
      );
    }

    await markGroupMemberAsLeft(tx, groupId, userId);
  });
}
