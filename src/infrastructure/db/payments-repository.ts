import type { Queryable } from './pool.js';

export interface PaymentRow {
  readonly id: string;
  readonly groupId: string;
  readonly fromUser: string;
  readonly toUser: string;
  /** In currencyCode: what actually changed hands. */
  readonly amountCents: number;
  /** What it was handed over in. A USDT debt can be settled in bolivianos. */
  readonly currencyCode: string;
  /** Millionths of currencyCode per USDT, frozen the day it was paid. */
  readonly rateMicros: number;
  /** The same money in the unit the ledger settles in. */
  readonly amountUsdtCents: number;
  readonly paidAt: Date;
  readonly createdBy: string;
  readonly createdAt: Date;
}

const PAYMENT_COLUMNS = `id,
       group_id          AS "groupId",
       from_user         AS "fromUser",
       to_user           AS "toUser",
       amount_cents      AS "amountCents",
       currency_code     AS "currencyCode",
       rate_micros       AS "rateMicros",
       amount_usdt_cents AS "amountUsdtCents",
       paid_at           AS "paidAt",
       created_by        AS "createdBy",
       created_at        AS "createdAt"`;

export async function insertPayment(
  db: Queryable,
  payment: {
    groupId: string;
    fromUser: string;
    toUser: string;
    amountCents: number;
    currencyCode: string;
    rateMicros: number;
    amountUsdtCents: number;
    paidAt: Date | null;
    createdBy: string;
  },
): Promise<PaymentRow> {
  const { rows } = await db.query<PaymentRow>(
    `INSERT INTO payments (group_id, from_user, to_user, amount_cents,
                           currency_code, rate_micros, amount_usdt_cents,
                           paid_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9)
     RETURNING ${PAYMENT_COLUMNS}`,
    [
      payment.groupId,
      payment.fromUser,
      payment.toUser,
      payment.amountCents,
      payment.currencyCode,
      payment.rateMicros,
      payment.amountUsdtCents,
      payment.paidAt,
      payment.createdBy,
    ],
  );

  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error('INSERT ... RETURNING gave no row back');
  }

  return inserted;
}

/**
 * One live payment, or null.
 *
 * Needed before deleting one: who is allowed to strike a payment through
 * depends on who wrote it down and who handed the money over, and neither of
 * those is knowable from the id alone.
 */
export async function findPayment(
  db: Queryable,
  groupId: string,
  paymentId: string,
): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS}
       FROM payments
      WHERE group_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [groupId, paymentId],
  );

  return rows[0] ?? null;
}

export async function listPayments(
  db: Queryable,
  groupId: string,
): Promise<PaymentRow[]> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS}
       FROM payments
      WHERE group_id = $1 AND deleted_at IS NULL
      ORDER BY paid_at DESC, created_at DESC`,
    [groupId],
  );

  return rows;
}

/** Voids a payment. Like an expense, it is struck through, never removed. */
export async function voidPayment(
  db: Queryable,
  groupId: string,
  paymentId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE payments SET deleted_at = now()
      WHERE group_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [groupId, paymentId],
  );

  return rowCount === 1;
}
