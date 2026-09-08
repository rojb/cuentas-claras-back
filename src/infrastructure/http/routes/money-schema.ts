import { z } from 'zod';
import { RATE_SCALE, SPENDABLE_CURRENCIES } from '../../../domain/currency.js';

/**
 * The two fields that turn an amount into money the ledger can add up.
 *
 * They live together in one file because they always travel together: an
 * amount without the currency it was paid in is a number, and a currency
 * without the rate it was converted at is a number the ledger cannot use.
 * Expenses and payments both need the pair, and one definition is what stops
 * the two endpoints from slowly disagreeing about what a rate is.
 */
export const currencyCode = z.enum(SPENDABLE_CURRENCIES);

/**
 * Millionths of `currencyCode` per one USDT: 6,96 arrives as 6_960_000.
 *
 * REQUIRED, even for USDT, where the only valid answer is 1_000_000.
 *
 * Defaulting it would be friendlier and wrong. A missing rate on a boliviano
 * expense would quietly become one-to-one, and the ledger would swallow
 * Bs 696 as 696 USDT without a word of complaint. Money is the wrong place
 * to guess, so the client says it every time and the domain checks it (see
 * assertRate in domain/currency.ts, which is what refuses a rate for USDT
 * that is not par).
 */
export const rateMicros = z
  .int()
  .positive()
  // A rate of a hundred million to one is not a rate, it is a typo, and the
  // ceiling is what keeps a slipped keystroke from becoming a zero balance.
  .max(RATE_SCALE * 1_000_000);
