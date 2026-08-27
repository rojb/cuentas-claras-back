import { assertAmountCents, sumIntegers } from './money.js';

/**
 * Splits an amount by explicit per-participant amounts.
 *
 * Here the user already decided who owes what ("I had the steak, you had
 * the salad"), so there is nothing to distribute and no leftover cents to
 * hand out. The only job of this function is to refuse a split that does
 * not add up: if the parts do not equal the total exactly, the expense is
 * wrong and must not reach the ledger.
 *
 * @param totalCents   Amount of the expense, in cents.
 * @param amountsCents What each participant owes, in cents, in participant order.
 * @returns The same shares, once validated.
 */
export function splitByExactAmounts(
  totalCents: number,
  amountsCents: readonly number[],
): number[] {
  assertAmountCents(totalCents, 'totalCents');

  if (amountsCents.length === 0) {
    throw new Error('amountsCents must contain at least one participant');
  }

  amountsCents.forEach((amount, index) =>
    assertAmountCents(amount, `amountsCents[${index}]`),
  );

  const assignedCents = sumIntegers(amountsCents);

  if (assignedCents !== totalCents) {
    const difference = totalCents - assignedCents;
    const problem =
      difference > 0
        ? `${difference} cents are missing`
        : `${Math.abs(difference)} cents too many were assigned`;

    throw new Error(
      `amounts must add up to totalCents (${totalCents}), but they add up to ${assignedCents}: ${problem}`,
    );
  }

  // A copy, so the caller cannot mutate the ledger's numbers from the outside.
  return [...amountsCents];
}
