import type { Database } from '../../infrastructure/db/pool.js';
import {
  findUserByEmail,
  isUniqueViolation,
} from '../../infrastructure/db/users-repository.js';
import { isGroupMember } from '../../infrastructure/db/groups-repository.js';
import {
  findPendingInvitation,
  insertInvitation,
  type InvitationRecord,
} from '../../infrastructure/db/invitations-repository.js';
import { conflict, notFound } from '../../infrastructure/http/errors.js';
import { requireMembership } from './membership.js';

export interface InviteGroupMemberInput {
  readonly email: string;
}

export interface InvitedPerson {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Invites somebody to a group. It does NOT add them.
 *
 * That distinction is the whole feature. Being in a group means your name
 * shows up on other people's bills, so it is not something anybody else gets
 * to decide for you. This writes down a question; the membership only exists
 * once the other person has answered it.
 *
 * Who is allowed to ask: any member. These are groups of friends, not
 * companies — inventing owners and admins would buy a permission model nobody
 * asked for. If roles ever become a real requirement they go in group_members
 * as a column, and this line is the only one that changes.
 *
 * The person has to be registered already. Inviting an email that nobody has
 * signed up with is a separate feature: it needs an invitation that does not
 * point at a user yet, plus a rule for what happens the day that email
 * registers. Answering 404 is the honest version of not having built it.
 */
export async function inviteGroupMember(
  db: Database,
  groupId: string,
  invitedBy: string,
  input: InviteGroupMemberInput,
): Promise<{
  invitation: InvitationRecord;
  invitee: InvitedPerson;
  created: boolean;
}> {
  await requireMembership(db, groupId, invitedBy);

  const invited = await findUserByEmail(db, input.email);

  if (invited === null) {
    throw notFound('user_not_found', 'nobody is registered with that email');
  }

  const invitee: InvitedPerson = {
    userId: invited.id,
    email: invited.email,
    displayName: invited.displayName,
  };

  if (invited.id === invitedBy) {
    throw conflict('already_a_member', 'you are already in this group');
  }

  if (await isGroupMember(db, groupId, invited.id)) {
    throw conflict('already_a_member', 'that person is already in this group');
  }

  // Asking twice is not an error, it is the same question. Answering 200 with
  // the invitation that is already open keeps a retry over a bad connection
  // from turning into two of them.
  const open = await findPendingInvitation(db, groupId, invited.id);
  if (open !== null) {
    return { invitation: open, invitee, created: false };
  }

  try {
    return {
      invitation: await insertInvitation(db, {
        groupId,
        invitedUser: invited.id,
        invitedBy,
      }),
      invitee,
      created: true,
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Two invitations raced and the partial unique index caught the loser.
    // The winner's row is the answer to both requests.
    const invitation = await findPendingInvitation(db, groupId, invited.id);

    if (invitation === null) {
      throw new Error('the invitation we just lost a race to is not there');
    }

    return { invitation, invitee, created: false };
  }
}
