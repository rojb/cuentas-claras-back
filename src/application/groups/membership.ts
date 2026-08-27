import type { Queryable } from '../../infrastructure/db/pool.js';
import {
  findGroupById,
  isGroupMember,
  type GroupRecord,
} from '../../infrastructure/db/groups-repository.js';
import { notFound } from '../../infrastructure/http/errors.js';

/**
 * The single gate in front of everything a group owns.
 *
 * Every group-scoped use case starts by calling this. Expenses, balances and
 * settlements will all go through here too, so the rule "you only see what
 * you are part of" is written down exactly once.
 *
 * A group you do not belong to answers 404, not 403. A 403 would confirm the
 * group exists, and by walking ids somebody could map out who is grouped
 * with whom. If it is not yours, as far as you are concerned it is not there.
 */
export async function requireMembership(
  db: Queryable,
  groupId: string,
  userId: string,
): Promise<GroupRecord> {
  const group = await findGroupById(db, groupId);

  if (group === null || !(await isGroupMember(db, groupId, userId))) {
    throw notFound('group_not_found', 'that group does not exist');
  }

  return group;
}
