import {
  withTransaction,
  type Database,
  type Queryable,
} from '../../infrastructure/db/pool.js';
import {
  findGroupById,
  insertGroupMember,
  type GroupRecord,
} from '../../infrastructure/db/groups-repository.js';
import {
  answerInvitation,
  listIncomingInvitations,
  listPendingGuests,
  lockInvitationFor,
  type IncomingInvitationRecord,
  type PendingGuestRecord,
} from '../../infrastructure/db/invitations-repository.js';
import { conflict, notFound } from '../../infrastructure/http/errors.js';
import { requireMembership } from './membership.js';

/** Everything waiting for this person's answer. */
export async function listMyInvitations(
  db: Database,
  userId: string,
): Promise<IncomingInvitationRecord[]> {
  return listIncomingInvitations(db, userId);
}

/** Who a group is still waiting on. Members only, like everything else. */
export async function listGroupPendingGuests(
  db: Database,
  groupId: string,
  userId: string,
): Promise<PendingGuestRecord[]> {
  await requireMembership(db, groupId, userId);

  return listPendingGuests(db, groupId);
}

/**
 * Says yes, and becomes a member in the same breath.
 *
 * One transaction, because "the invitation is accepted" and "you are in the
 * group" are the same fact written in two tables. Committing one without the
 * other would leave either an accepted invitation that did nothing, or a
 * membership nobody can explain.
 *
 * insertGroupMember is the same upsert that add-a-friend used to call, which
 * is what makes accepting an invitation to a group you once left revive your
 * old membership row instead of trying to insert a duplicate — the ledger is
 * still hanging off that row.
 */
export async function acceptInvitation(
  db: Database,
  invitationId: string,
  userId: string,
): Promise<{ group: GroupRecord }> {
  return withTransaction(db, async (tx) => {
    const invitation = await requirePendingInvitation(tx, invitationId, userId);

    await answerInvitation(tx, invitationId, 'accepted');
    await insertGroupMember(tx, { groupId: invitation.groupId, userId });

    const group = await findGroupById(tx, invitation.groupId);

    if (group === null) {
      throw new Error('accepted an invitation to a group that is not there');
    }

    return { group };
  });
}

/**
 * Says no.
 *
 * The row is answered, not deleted. "Ana was asked and said no" is worth
 * knowing — it is what stops the app from looking like the invitation never
 * arrived, and it lets somebody ask again later without the two attempts
 * colliding: only PENDING invitations are unique per person per group.
 */
export async function rejectInvitation(
  db: Database,
  invitationId: string,
  userId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await requirePendingInvitation(tx, invitationId, userId);
    await answerInvitation(tx, invitationId, 'rejected');
  });
}

/**
 * The gate in front of both answers.
 *
 * An invitation addressed to somebody else answers 404 and not 403, for the
 * same reason a group you are not in does: a 403 would confirm the invitation
 * exists, and by walking ids somebody could map out who is being invited to
 * what. If it is not yours, as far as you are concerned it is not there.
 */
async function requirePendingInvitation(
  tx: Queryable,
  invitationId: string,
  userId: string,
) {
  const invitation = await lockInvitationFor(tx, invitationId, userId);

  if (invitation === null) {
    throw notFound('invitation_not_found', 'that invitation does not exist');
  }

  if (invitation.status !== 'pending') {
    throw conflict(
      'invitation_already_answered',
      `you already ${invitation.status} that invitation`,
    );
  }

  return invitation;
}
