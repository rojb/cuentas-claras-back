import type { Queryable } from './pool.js';

/** An invitation as the person who sent it sees it. */
export interface InvitationRecord {
  readonly id: string;
  readonly groupId: string;
  readonly invitedUser: string;
  readonly invitedBy: string;
  readonly status: 'pending' | 'accepted' | 'rejected';
  readonly createdAt: Date;
  readonly respondedAt: Date | null;
}

/** An invitation as the person who received it sees it: with context. */
export interface IncomingInvitationRecord extends InvitationRecord {
  readonly groupName: string;
  readonly currencyCode: string;
  readonly invitedByName: string;
  readonly memberCount: number;
}

/** Somebody who has been asked and has not answered yet. */
export interface PendingGuestRecord {
  readonly invitationId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly invitedAt: Date;
}

const INVITATION_COLUMNS = `id,
       group_id     AS "groupId",
       invited_user AS "invitedUser",
       invited_by   AS "invitedBy",
       status,
       created_at   AS "createdAt",
       responded_at AS "respondedAt"`;

export async function insertInvitation(
  db: Queryable,
  invitation: { groupId: string; invitedUser: string; invitedBy: string },
): Promise<InvitationRecord> {
  const { rows } = await db.query<InvitationRecord>(
    `INSERT INTO group_invitations (group_id, invited_user, invited_by)
     VALUES ($1, $2, $3)
     RETURNING ${INVITATION_COLUMNS}`,
    [invitation.groupId, invitation.invitedUser, invitation.invitedBy],
  );

  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error('INSERT ... RETURNING gave no row back');
  }

  return inserted;
}

export async function findPendingInvitation(
  db: Queryable,
  groupId: string,
  invitedUser: string,
): Promise<InvitationRecord | null> {
  const { rows } = await db.query<InvitationRecord>(
    `SELECT ${INVITATION_COLUMNS}
       FROM group_invitations
      WHERE group_id = $1 AND invited_user = $2 AND status = 'pending'`,
    [groupId, invitedUser],
  );

  return rows[0] ?? null;
}

/**
 * The invitation, held for the rest of the caller's transaction.
 *
 * Answering is read-then-write — check it is still pending, then write the
 * answer and the membership — and two taps on a flaky connection are exactly
 * how that turns into two memberships. The lock makes the second one wait and
 * find an invitation that has already been answered.
 *
 * Scoped to the invited user on purpose: an invitation somebody else received
 * answers null, which the use case turns into a 404. Anything else would let
 * you discover, one id at a time, who is being invited to what.
 */
export async function lockInvitationFor(
  db: Queryable,
  invitationId: string,
  invitedUser: string,
): Promise<InvitationRecord | null> {
  const { rows } = await db.query<InvitationRecord>(
    `SELECT ${INVITATION_COLUMNS}
       FROM group_invitations
      WHERE id = $1 AND invited_user = $2
        FOR UPDATE`,
    [invitationId, invitedUser],
  );

  return rows[0] ?? null;
}

export async function answerInvitation(
  db: Queryable,
  invitationId: string,
  status: 'accepted' | 'rejected',
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE group_invitations
        SET status = $2, responded_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [invitationId, status],
  );

  return rowCount === 1;
}

/**
 * Everything waiting for this person's answer, oldest first.
 *
 * The group name and the inviter's name are joined in rather than left for
 * the client to look up: an invitation the app can only render as a pair of
 * uuids is not something anybody can decide about.
 */
export async function listIncomingInvitations(
  db: Queryable,
  userId: string,
): Promise<IncomingInvitationRecord[]> {
  const { rows } = await db.query<IncomingInvitationRecord>(
    `SELECT i.id,
            i.group_id     AS "groupId",
            i.invited_user AS "invitedUser",
            i.invited_by   AS "invitedBy",
            i.status,
            i.created_at   AS "createdAt",
            i.responded_at AS "respondedAt",
            g.name          AS "groupName",
            g.currency_code AS "currencyCode",
            u.display_name  AS "invitedByName",
            (SELECT count(*)
               FROM group_members m
              WHERE m.group_id = g.id AND m.left_at IS NULL) AS "memberCount"
       FROM group_invitations i
       JOIN expense_groups g ON g.id = i.group_id
       JOIN users u          ON u.id = i.invited_by
      WHERE i.invited_user = $1 AND i.status = 'pending'
      ORDER BY i.created_at`,
    [userId],
  );

  return rows;
}

/** Who a group is still waiting on. */
export async function listPendingGuests(
  db: Queryable,
  groupId: string,
): Promise<PendingGuestRecord[]> {
  const { rows } = await db.query<PendingGuestRecord>(
    `SELECT i.id          AS "invitationId",
            u.id          AS "userId",
            u.email,
            u.display_name AS "displayName",
            i.created_at   AS "invitedAt"
       FROM group_invitations i
       JOIN users u ON u.id = i.invited_user
      WHERE i.group_id = $1 AND i.status = 'pending'
      ORDER BY i.created_at`,
    [groupId],
  );

  return rows;
}
