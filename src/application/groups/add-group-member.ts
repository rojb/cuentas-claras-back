import type { Database } from '../../infrastructure/db/pool.js';
import { findUserByEmail } from '../../infrastructure/db/users-repository.js';
import {
  findGroupMember,
  insertGroupMember,
  type MemberRecord,
} from '../../infrastructure/db/groups-repository.js';
import { notFound } from '../../infrastructure/http/errors.js';
import { requireMembership } from './membership.js';

export interface AddGroupMemberInput {
  readonly email: string;
}

/**
 * Adds a friend to a group, found by their email.
 *
 * Who is allowed to do this: any member. These are groups of friends, not
 * companies — inventing owners and admins would buy a permission model
 * nobody asked for. If roles ever become a real requirement, they go in
 * group_members as a column, and this line is the only one that changes.
 *
 * The person has to be registered already. Invitations to people without an
 * account are a separate feature (a pending invite that becomes a membership
 * on sign-up), not a variation of this one.
 */
export async function addGroupMember(
  db: Database,
  groupId: string,
  requestedBy: string,
  input: AddGroupMemberInput,
): Promise<{ member: MemberRecord; added: boolean }> {
  await requireMembership(db, groupId, requestedBy);

  const invited = await findUserByEmail(db, input.email);

  if (invited === null) {
    throw notFound('user_not_found', 'nobody is registered with that email');
  }

  const added = await insertGroupMember(db, { groupId, userId: invited.id });

  const member = await findGroupMember(db, groupId, invited.id);

  if (member === null) {
    throw new Error('the member we just added is not in the group');
  }

  return { member, added };
}
