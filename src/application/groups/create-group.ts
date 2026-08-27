import { withTransaction, type Database } from '../../infrastructure/db/pool.js';
import {
  insertGroup,
  insertGroupMember,
  type GroupRecord,
} from '../../infrastructure/db/groups-repository.js';

export interface CreateGroupInput {
  readonly name: string;
  readonly currencyCode: string;
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
      currencyCode: input.currencyCode,
      createdBy,
    });

    await insertGroupMember(tx, { groupId: created.id, userId: createdBy });

    return created;
  });

  return { group };
}
