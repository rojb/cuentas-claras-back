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
 * Adds someone to a group.
 *
 * ON CONFLICT DO NOTHING makes this idempotent: pressing "add Ana" twice is
 * not an error, it is the same outcome. Returns whether the row was new.
 */
export async function insertGroupMember(
  db: Queryable,
  membership: { groupId: string; userId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO group_members (group_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (group_id, user_id) DO NOTHING`,
    [membership.groupId, membership.userId],
  );

  return rowCount === 1;
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

export async function isGroupMember(
  db: Queryable,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
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
            (SELECT count(*) FROM group_members m WHERE m.group_id = g.id) AS "memberCount"
       FROM expense_groups g
       JOIN group_members mine ON mine.group_id = g.id AND mine.user_id = $1
      ORDER BY g.created_at DESC`,
    [userId],
  );

  return rows;
}

export async function findGroupMember(
  db: Queryable,
  groupId: string,
  userId: string,
): Promise<MemberRecord | null> {
  const { rows } = await db.query<MemberRecord>(
    `SELECT u.id           AS "userId",
            u.email,
            u.display_name AS "displayName",
            m.joined_at    AS "joinedAt"
       FROM group_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.group_id = $1 AND m.user_id = $2`,
    [groupId, userId],
  );

  return rows[0] ?? null;
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
      WHERE m.group_id = $1
      ORDER BY m.joined_at, u.display_name`,
    [groupId],
  );

  return rows;
}
