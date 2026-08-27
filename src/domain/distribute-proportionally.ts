import { assertAmountCents, sumIntegers } from './money.js';

/**
 * Distributes an amount between participants in proportion to whole-number
 * weights, using the LARGEST REMAINDER METHOD.
 *
 * This is the engine shared by every proportional split. Percentages and
 * shares are only two ways of writing the same weights:
 *
 *   33.33% / 33.33% / 33.34%  ->  weights 3333 / 3333 / 3334
 *   2 shares / 1 share        ->  weights    2 /    1
 *
 * Every exact share is rounded DOWN first, which always leaves a few cents
 * unassigned. Those leftover cents go to the participants whose share was
 * cut the most by that rounding — the same rule used to hand out
 * parliamentary seats from vote counts.
 *
 * @param totalCents Amount to distribute, in cents.
 * @param weights    Relative weight per participant. Whole, non-negative,
 *                   and adding up to more than zero.
 * @returns One share per participant, in cents, summing exactly to totalCents.
 */
export function distributeProportionally(
  totalCents: number,
  weights: readonly number[],
): number[] {
  assertAmountCents(totalCents, 'totalCents');

  const totalWeight = sumIntegers(weights);

  if (totalWeight <= 0) {
    throw new Error(
      `weights must add up to more than zero, got ${totalWeight}`,
    );
  }

  // Scaled by totalWeight so it stays a whole number: no rounding yet.
  const scaledShares = weights.map((weight) => totalCents * weight);

  const roundedDownShares = scaledShares.map((scaled) =>
    Math.floor(scaled / totalWeight),
  );

  // Rounding down always leaves cents on the table, but never more than one
  // per participant: each discarded remainder is below a full cent.
  const leftoverCents = totalCents - sumIntegers(roundedDownShares);

  const getsAnExtraCent = new Set(
    scaledShares
      .map((scaled, index) => ({ index, remainder: scaled % totalWeight }))
      // Biggest loss first; on a tie the earlier participant wins, so the
      // result is always the same for the same input.
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
      .slice(0, leftoverCents)
      .map((entry) => entry.index),
  );

  return roundedDownShares.map((share, index) =>
    getsAnExtraCent.has(index) ? share + 1 : share,
  );
}
