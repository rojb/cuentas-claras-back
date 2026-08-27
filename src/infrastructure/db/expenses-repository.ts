import type { Queryable } from './pool.js';

export interface ExpenseRow {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  readonly totalCents: number;
  readonly paidBy: string;
  readonly splitStrategy: string;
  readonly spentAt: Date;
  /** The split exactly as it was asked for, so an edit can reopen it. */
  readonly splitParams: unknown;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface ShareRow {
  readonly expenseId: string;
  readonly userId: string;
  readonly shareCents: number;
}

export interface ItemRow {
  readonly id: string;
  readonly expenseId: string;
  readonly position: number;
  readonly description: string;
  readonly amountCents: number;
  readonly splitStrategy: string;
}

const EXPENSE_COLUMNS = `id,
       group_id       AS "groupId",
       description,
       total_cents    AS "totalCents",
       paid_by        AS "paidBy",
       split_strategy AS "splitStrategy",
       split_params   AS "splitParams",
       spent_at       AS "spentAt",
       created_by     AS "createdBy",
       created_at     AS "createdAt"`;

export async function insertExpense(
  db: Queryable,
  expense: {
    groupId: string;
    description: string;
    totalCents: number;
    paidBy: string;
    splitStrategy: string;
    splitParams: unknown;
    spentAt: Date | null;
    createdBy: string;
  },
): Promise<ExpenseRow> {
  const { rows } = await db.query<ExpenseRow>(
    `INSERT INTO expenses (group_id, description, total_cents, paid_by,
                           split_strategy, split_params, spent_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, now()), $8)
     RETURNING ${EXPENSE_COLUMNS}`,
    [
      expense.groupId,
      expense.description,
      expense.totalCents,
      expense.paidBy,
      expense.splitStrategy,
      JSON.stringify(expense.splitParams),
      expense.spentAt,
      expense.createdBy,
    ],
  );

  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error('INSERT ... RETURNING gave no row back');
  }

  return inserted;
}

/**
 * Writes every share of an expense in one statement.
 *
 * One INSERT per person would work, but each round trip is a chance for the
 * connection to die halfway through a set of numbers that only means
 * anything complete. unnest() sends them as three arrays and lets Postgres
 * expand them into rows.
 */
export async function insertExpenseShares(
  db: Queryable,
  expenseId: string,
  groupId: string,
  shares: readonly { userId: string; shareCents: number }[],
): Promise<void> {
  await db.query(
    `INSERT INTO expense_shares (expense_id, group_id, user_id, share_cents)
     SELECT $1, $2, user_id, share_cents
       FROM unnest($3::uuid[], $4::bigint[]) AS s(user_id, share_cents)`,
    [
      expenseId,
      groupId,
      shares.map((share) => share.userId),
      shares.map((share) => share.shareCents),
    ],
  );
}

export async function insertExpenseItem(
  db: Queryable,
  item: {
    expenseId: string;
    groupId: string;
    position: number;
    description: string;
    amountCents: number;
    splitStrategy: string;
    splitParams: unknown;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO expense_items (expense_id, group_id, position, description,
                                amount_cents, split_strategy, split_params)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      item.expenseId,
      item.groupId,
      item.position,
      item.description,
      item.amountCents,
      item.splitStrategy,
      JSON.stringify(item.splitParams),
    ],
  );

  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error('INSERT ... RETURNING gave no row back');
  }

  return inserted.id;
}

export async function insertItemParticipants(
  db: Queryable,
  itemId: string,
  groupId: string,
  participants: readonly string[],
): Promise<void> {
  await db.query(
    `INSERT INTO expense_item_participants (item_id, group_id, user_id, position)
     SELECT $1, $2, user_id, position - 1
       FROM unnest($3::uuid[]) WITH ORDINALITY AS p(user_id, position)`,
    [itemId, groupId, [...participants]],
  );
}

/** Live expenses of a group, newest spend first. Voided ones stay hidden. */
export async function listExpenses(
  db: Queryable,
  groupId: string,
): Promise<ExpenseRow[]> {
  const { rows } = await db.query<ExpenseRow>(
    `SELECT ${EXPENSE_COLUMNS}
       FROM expenses
      WHERE group_id = $1 AND deleted_at IS NULL
      ORDER BY spent_at DESC, created_at DESC`,
    [groupId],
  );

  return rows;
}

export async function findExpense(
  db: Queryable,
  groupId: string,
  expenseId: string,
): Promise<ExpenseRow | null> {
  const { rows } = await db.query<ExpenseRow>(
    `SELECT ${EXPENSE_COLUMNS}
       FROM expenses
      WHERE group_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [groupId, expenseId],
  );

  return rows[0] ?? null;
}

/** The shares of every live expense in a group, in one query. */
export async function listShares(
  db: Queryable,
  groupId: string,
): Promise<ShareRow[]> {
  const { rows } = await db.query<ShareRow>(
    `SELECT s.expense_id  AS "expenseId",
            s.user_id     AS "userId",
            s.share_cents AS "shareCents"
       FROM expense_shares s
       JOIN expenses e ON e.id = s.expense_id
      WHERE s.group_id = $1 AND e.deleted_at IS NULL`,
    [groupId],
  );

  return rows;
}

export async function listSharesOf(
  db: Queryable,
  expenseId: string,
): Promise<ShareRow[]> {
  const { rows } = await db.query<ShareRow>(
    `SELECT expense_id AS "expenseId", user_id AS "userId", share_cents AS "shareCents"
       FROM expense_shares
      WHERE expense_id = $1`,
    [expenseId],
  );

  return rows;
}

/** Marks an expense as void. The row stays: a ledger corrects, it never erases. */
export async function voidExpense(
  db: Queryable,
  groupId: string,
  expenseId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE expenses SET deleted_at = now()
      WHERE group_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [groupId, expenseId],
  );

  return rowCount === 1;
}
