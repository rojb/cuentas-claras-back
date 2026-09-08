/**
 * Money in this app is spent in several currencies and owed in exactly one.
 *
 * A group used to have a currency; it does not any more. People pay for
 * dinner in bolivianos, a hotel in dollars and a transfer in USDT, and what
 * they want at the end is a single number telling them who owes whom. So
 * USDT is not "one of the currencies" — it is the unit the LEDGER is written
 * in, and everything else is converted into it on the way in.
 *
 * THE RATE IS PART OF THE EXPENSE, not a thing we look up later.
 *
 * That is the whole design, and it is worth being explicit about what it
 * buys, because the other option is tempting and wrong. If we stored the
 * bolivianos and converted them at read time, then:
 *
 *   - Balances would move on their own. Nathalia goes to sleep owing 50 USDT
 *     and wakes up owing 46,40 because a rate moved while she slept.
 *   - She could pay those 50 USDT in full and still be left with 3,60 in her
 *     favour the next morning, having done nothing.
 *   - A balance from last week could never be reproduced.
 *   - And the invariant would break outright: round(a x r) + round(b x r) is
 *     not round((a + b) x r), so the shares of an expense would stop adding
 *     up to its total the moment the rate changed.
 *
 * Freezing the rate makes an expense what it always claimed to be: a fact.
 * Bs 696 at 6,96 was 100 USDT that night, and it stays 100 USDT forever.
 * The price is that a debt fixed in USDT drifts in bolivianos — which is the
 * honest half of the trade, because once a rate moves SOMETHING has to give,
 * and the thing we settle in is the thing worth holding still.
 */

/** The unit every balance, settlement and debt in the app is written in. */
export const SETTLEMENT_CURRENCY = 'USDT';

/** What an expense is allowed to have been paid in. */
export const SPENDABLE_CURRENCIES = ['USDT', 'BOB', 'USD'] as const;

export type CurrencyCode = (typeof SPENDABLE_CURRENCIES)[number];

/**
 * Rates are integers too.
 *
 * A rate is a decimal by nature — 6,96 bolivianos to the dollar — and a
 * decimal is exactly the thing this codebase refuses to put near money. So
 * it is stored scaled by a million: 6,96 travels and lives in the database
 * as 6_960_000 millionths of a boliviano per USDT.
 *
 * A million is not arbitrary. Six digits is what USDT itself uses on chain,
 * and it leaves room for the kind of rate nobody thinks about until it shows
 * up in a screenshot: 6,957382 is representable, 6,96 is not a rounding of
 * anything.
 */
export const RATE_SCALE = 1_000_000;

/** One USDT is one USDT. The only rate that is not a matter of opinion. */
export const PAR_RATE_MICROS = RATE_SCALE;

/**
 * The largest amount we will convert.
 *
 * Converting multiplies by a million, and JavaScript numbers are exact only
 * up to 2^53. Past this line the arithmetic silently starts lying, so it is
 * refused loudly instead. It sits at roughly 45 million units of currency —
 * far past any dinner, and far below the point where the result is wrong.
 */
const LARGEST_CONVERTIBLE_CENTS = Math.floor(
  Number.MAX_SAFE_INTEGER / (2 * RATE_SCALE),
);

export function isSpendableCurrency(value: string): value is CurrencyCode {
  return (SPENDABLE_CURRENCIES as readonly string[]).includes(value);
}

/**
 * Checks that a rate is usable, and that nobody is quoting a rate for USDT.
 *
 * The second half matters more than it looks. "1 USDT = 1,02 USDT" is not a
 * rate, it is a typo or a thumb on the scale, and accepting it would let an
 * expense of 100 USDT land in the ledger as 98.
 */
export function assertRate(
  currencyCode: CurrencyCode,
  rateMicros: number,
  label = 'rateMicros',
): void {
  if (!Number.isInteger(rateMicros)) {
    throw new Error(
      `${label} must be an integer number of millionths, got ${rateMicros}`,
    );
  }

  if (rateMicros <= 0) {
    throw new Error(`${label} must be greater than zero, got ${rateMicros}`);
  }

  if (currencyCode === SETTLEMENT_CURRENCY && rateMicros !== PAR_RATE_MICROS) {
    throw new Error(
      `${SETTLEMENT_CURRENCY} converts to itself at ${PAR_RATE_MICROS}, ` +
        `got ${rateMicros}`,
    );
  }
}

/**
 * Converts an amount into the currency the ledger settles in.
 *
 * @param amountCents Amount in the currency it was actually spent in.
 * @param rateMicros  Millionths of that currency per one USDT.
 * @returns The same money, in USDT cents, rounded to the nearest cent.
 *
 * CALL THIS ONCE PER EXPENSE, ON THE TOTAL — never on each person's share.
 *
 * Converting each share separately rounds each one separately, and a handful
 * of independent roundings do not add back up to the converted total. Bs 100
 * between three is 33,34 / 33,33 / 33,33; convert those three at 6,96 and
 * you get 4,79 + 4,79 + 4,79 = 14,37, which happens to be right, and at the
 * next rate happens not to be. Convert the total first and divide the result
 * and it cannot happen at all: there is one rounding, and the split that
 * follows already guarantees the parts add up.
 */
export function toSettlementCents(
  amountCents: number,
  rateMicros: number,
): number {
  if (!Number.isInteger(amountCents)) {
    throw new Error(
      `amountCents must be an integer number of cents, got ${amountCents}`,
    );
  }

  if (amountCents < 0) {
    throw new Error(`amountCents cannot be negative, got ${amountCents}`);
  }

  if (amountCents > LARGEST_CONVERTIBLE_CENTS) {
    throw new Error(
      `amountCents is too large to convert exactly: ${amountCents} is past ` +
        `${LARGEST_CONVERTIBLE_CENTS}`,
    );
  }

  if (!Number.isInteger(rateMicros) || rateMicros <= 0) {
    throw new Error(`rateMicros must be a positive integer, got ${rateMicros}`);
  }

  // Round half up, in integers: floor(x / r + 1/2) written so that the
  // halving never produces a fraction of its own.
  const scaled = amountCents * RATE_SCALE;

  return Math.floor((2 * scaled + rateMicros) / (2 * rateMicros));
}
