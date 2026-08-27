import type { Queryable } from './pool.js';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

/** Postgres error code for "a UNIQUE constraint was violated". */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export async function insertUser(
  db: Queryable,
  user: { email: string; passwordHash: string; displayName: string },
): Promise<UserRecord> {
  const { rows } = await db.query<UserRecord>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name AS "displayName", password_hash AS "passwordHash"`,
    [user.email, user.passwordHash, user.displayName],
  );

  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error('INSERT ... RETURNING gave no row back');
  }

  return inserted;
}

export async function findUserByEmail(
  db: Queryable,
  email: string,
): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>(
    `SELECT id, email, display_name AS "displayName", password_hash AS "passwordHash"
     FROM users
     WHERE lower(email) = lower($1)`,
    [email],
  );

  return rows[0] ?? null;
}
