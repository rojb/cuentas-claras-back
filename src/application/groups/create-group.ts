import { withTransaction, type Database } from '../../infrastructure/db/pool.js';
import {
  insertGroup,
  insertGroupMember,
  type GroupRecord,
} from '../../infrastructure/db/groups-repository.js';

/**
 * A group has no currency.
 *
 * It used to, and it was a lie: people on one trip pay for dinner in
 * bolivianos, a hotel in dollars and each other in USDT. The currency moved
 * down to the individual expense, where it belongs, and the group settles
 * everything in USDT.
 */
export interface CreateGroupInput {
  readonly name: string;
}

/**
 * Creates a group and puts its creator inside it.
 *
 * Both writes live in one transaction on purpose. A group with nobody in it
 * is not a smaller version of the truth, it is a broken row: its own creator
 * could not see it, because requireMembership() would not find them in it.
 */
export async function createGroup(
  db: Database,
  createdBy: string,
  input: CreateGroupInput,
): Promise<{ group: GroupRecord }> {
  const group = await withTransaction(db, async (tx) => {
    const created = await insertGroup(tx, {
      name: input.name,
      createdBy,
    });

    await insertGroupMember(tx, { groupId: created.id, userId: createdBy });

    return created;
  });

  return { group };
}
