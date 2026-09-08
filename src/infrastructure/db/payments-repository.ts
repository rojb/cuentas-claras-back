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

  /**
   * When it was undone, or null while it still counts.
   *
   * A voided payment is not gone: it stays out of the balances and stays IN
   * the history, struck through. Money moving and then un-moving is a thing
   * that happened, and a record it can vanish from is not a record.
   */
  readonly voidedAt: Date | null;

  /**
   * Who undid it. Not the same as who recorded it — the group's creator can
   * strike through somebody else's, which is exactly the case worth seeing.
   *
   * Null for payments voided before this was recorded at all; the screen says
   * "anulado" without a name rather than guessing one.
   */
  readonly voidedBy: string | null;
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
       created_at        AS "createdAt",
       deleted_at        AS "voidedAt",
       deleted_by        AS "voidedBy"`;

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

/**
 * The payments that still count, for the ledger.
 *
 * Voided ones are filtered out HERE and only here — this is what balances are
 * built from, and a payment that was undone must not move anybody's number.
 * The history uses listPaymentHistory instead, which keeps them.
 */
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

/**
 * Everything that ever happened, voided included.
 *
 * The whole point of the history tab: the balances say where things stand,
 * this says what was done to get there — including what was undone. Somebody
 * recording a payment and striking it through five minutes later leaves a
 * trace instead of leaving nothing.
 */
export async function listPaymentHistory(
  db: Queryable,
  groupId: string,
): Promise<PaymentRow[]> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS}
       FROM payments
      WHERE group_id = $1
      ORDER BY paid_at DESC, created_at DESC`,
    [groupId],
  );

  return rows;
}

/**
 * Voids a payment. Like an expense, it is struck through, never removed —
 * and now the row says who struck it through.
 *
 * `deleted_at IS NULL` in the WHERE is what makes this idempotent: voiding
 * something already void changes no rows and answers false, so two people
 * pressing the button at once cannot rewrite each other's author.
 */
export async function voidPayment(
  db: Queryable,
  groupId: string,
  paymentId: string,
  voidedBy: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE payments SET deleted_at = now(), deleted_by = $3
      WHERE group_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [groupId, paymentId, voidedBy],
  );

  return rowCount === 1;
}
