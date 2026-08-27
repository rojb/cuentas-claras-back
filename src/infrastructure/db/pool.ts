import pg from 'pg';

const { Pool, types } = pg;

/**
 * Postgres bigint (int8) arrives as a STRING by default, because a bigint can
 * be larger than JavaScript can represent exactly. Left alone, `share_cents`
 * would come back as "5000" and "5000" + 300 would quietly become "5000300".
 *
 * Our cents are safe as numbers: even a trillion pesos is far below 2^53. So
 * we parse int8 into a real number, once, here — not scattered around every
 * query with parseInt.
 */
types.setTypeParser(types.builtins.INT8, (value: string) => Number(value));

export type Database = pg.Pool;
export type Transaction = pg.PoolClient;

/** Either a pool or an open transaction — queries work the same on both. */
export type Queryable = Database | Transaction;

export function createPool(connectionString: string): Database {
  return new Pool({ connectionString });
}

/**
 * Runs a unit of work inside a single database transaction.
 *
 * This is what makes "an expense and its shares" one indivisible fact. If
 * anything throws halfway through, the ROLLBACK undoes everything and the
 * ledger is left exactly as it was — no expense without its shares, no
 * shares without their expense.
 */
export async function withTransaction<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    // Always give the connection back, success or failure. Forgetting this
    // is how a server slowly runs out of connections and freezes.
    client.release();
  }
}
