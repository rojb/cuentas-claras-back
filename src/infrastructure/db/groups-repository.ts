import type { Queryable } from './pool.js';

export interface GroupRecord {
  readonly id: string;
  readonly name: string;
  readonly currencyCode: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface MemberRecord {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly joinedAt: Date;
}

/** Postgres error code for "this row points at something that isn't there". */
const FOREIGN_KEY_VIOLATION = '23503';

export function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === FOREIGN_KEY_VIOLATION
  );
}

const GROUP_COLUMNS = `id,
       name,
       currency_code AS "currencyCode",
       created_by    AS "createdBy",
       created_at    AS "createdAt"`;

export async function insertGroup(
  db: Queryable,
  group: { name: string; currencyCode: string; createdBy: string },
): Promise<GroupRecord> {
  const { rows } = await db.query<GroupRecord>(
    `INSERT INTO expense_groups (name, currency_code, created_by)
     VALUES ($1, $2, $3)
     RETURNING ${GROUP_COLUMNS}`,
    [group.name, group.currencyCode, group.createdBy],
  );

  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error('INSERT ... RETURNING gave no row back');
  }

  return inserted;
}

/**
 * Adds someone to a group, or brings back someone who had left.
 *
 * ON CONFLICT makes this idempotent: pressing "add Ana" twice is not an
 * error, it is the same outcome. Returns whether the membership is new.
 *
 * The conflict has two different meanings now, and only one of them is a
 * no-op. If the row is there and active, nothing happens. If the row is there
 * because Ana left, that row IS her way back in — it has to be revived rather
 * than inserted, since the ledger's foreign keys already point at it. The
 * WHERE keeps the two apart, so an already-active member still reports false.
 *
 * joined_at is reset on the way back: she is in the group as of today, and
 * the old date would only make the member list lie about the order.
 */
export async function insertGroupMember(
  db: Queryable,
  membership: { groupId: string; userId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO group_members (group_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (group_id, user_id) DO UPDATE
        SET left_at   = NULL,
            joined_at = now()
      WHERE group_members.left_at IS NOT NULL`,
    [membership.groupId, membership.userId],
  );

  return rowCount === 1;
}

/**
 * Writes down that somebody left. The row stays: it is what the expenses and
 * payments they took part in are still hanging from.
 *
 * Returns false if they were not an active member to begin with, which makes
 * leaving twice a no-op instead of a silent success.
 */
export async function markGroupMemberAsLeft(
  db: Queryable,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE group_members
        SET left_at = now()
      WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [groupId, userId],
  );

  return rowCount === 1;
}

/**
 * Takes the membership row out of circulation for the rest of the caller's
 * transaction, and reports whether it was an active one.
 *
 * This is what makes "leave only if you are square" safe under concurrency.
 * Postgres takes a FOR KEY SHARE lock on this exact row whenever it writes an
 * expense share or a payment naming this person, and FOR UPDATE conflicts
 * with it — so an expense landing at the same instant as the goodbye has to
 * wait for one of the two to commit, instead of slipping between the balance
 * check and the update and leaving a debt with nobody attached to it.
 */
export async function lockActiveGroupMember(
  db: Queryable,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1
       FROM group_members
      WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL
        FOR UPDATE`,
    [groupId, userId],
  );

  return rowCount === 1;
}

/**
 * The other side of the same coin: "these people are in the group, and they
 * are not going anywhere until I commit".
 *
 * Returns which of the given users are active members, and holds each of
 * those rows for the rest of the caller's transaction. FOR KEY SHARE is the
 * exact lock Postgres itself takes when a row references this membership, so
 * this asks for nothing stronger than writing the expense already asks for:
 * two expenses in the same group never wait on each other, and a goodbye
 * (FOR UPDATE) does.
 *
 * Locking BEFORE validating is what makes the answer still true by COMMIT.
 * Checked without the lock, "Ana is a member" is a fact about the past.
 *
 * ORDER BY user_id so that every caller takes these rows in the same order,
 * which is the cheapest way to never have to think about deadlocks again.
 */
export async function lockActiveGroupMembers(
  db: Queryable,
  groupId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) {
    return new Set();
  }

  const { rows } = await db.query<{ userId: string }>(
    `SELECT user_id AS "userId"
       FROM group_members
      WHERE group_id = $1
        AND user_id = ANY($2::uuid[])
        AND left_at IS NULL
      ORDER BY user_id
        FOR KEY SHARE`,
    [groupId, [...new Set(userIds)]],
  );

  return new Set(rows.map((row) => row.userId));
}

export async function findGroupById(
  db: Queryable,
  groupId: string,
): Promise<GroupRecord | null> {
  const { rows } = await db.query<GroupRecord>(
    `SELECT ${GROUP_COLUMNS} FROM expense_groups WHERE id = $1`,
    [groupId],
  );

  return rows[0] ?? null;
}

/**
 * Membership means membership TODAY. Everything below filters on left_at,
 * because a row that outlived its membership is there for the ledger's
 * foreign keys, not to keep letting somebody read the group.
 */
export async function isGroupMember(
  db: Queryable,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1
       FROM group_members
      WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [groupId, userId],
  );

  return rowCount === 1;
}

/** Every group this user belongs to, newest first, with its head count. */
export async function listGroupsForUser(
  db: Queryable,
  userId: string,
): Promise<(GroupRecord & { memberCount: number })[]> {
  const { rows } = await db.query<GroupRecord & { memberCount: number }>(
    `SELECT g.id,
            g.name,
            g.currency_code AS "currencyCode",
            g.created_by    AS "createdBy",
            g.created_at    AS "createdAt",
            (SELECT count(*)
               FROM group_members m
              WHERE m.group_id = g.id AND m.left_at IS NULL) AS "memberCount"
       FROM expense_groups g
       JOIN group_members mine
         ON mine.group_id = g.id
        AND mine.user_id = $1
        AND mine.left_at IS NULL
      ORDER BY g.created_at DESC`,
    [userId],
  );

  return rows;
}

export async function listGroupMembers(
  db: Queryable,
  groupId: string,
): Promise<MemberRecord[]> {
  const { rows } = await db.query<MemberRecord>(
    `SELECT u.id           AS "userId",
            u.email,
            u.display_name AS "displayName",
            m.joined_at    AS "joinedAt"
       FROM group_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.group_id = $1 AND m.left_at IS NULL
      ORDER BY m.joined_at, u.display_name`,
    [groupId],
  );

  return rows;
}
