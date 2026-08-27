import { distributeProportionally } from './distribute-proportionally.js';
import { sumIntegers } from './money.js';

/**
 * Percentages are expressed in BASIS POINTS: whole hundredths of a percent.
 *
 * Same reasoning as cents. If percentages were decimals we would be back to
 * floating point, and 33.33 + 33.33 + 33.34 would not reliably equal 100.
 * As integers the check is exact: 3333 + 3333 + 3334 === 10000.
 *
 *   100%    -> 10000
 *    33.33% ->  3333
 *     0.01% ->     1
 */
export const BASIS_POINTS_IN_FULL = 10_000;

/**
 * Splits an amount by a percentage per participant.
 *
 * The percentages must add up to exactly 100%; anything else is a broken
 * expense and is rejected. The actual cents are then worked out by the
 * shared proportional engine.
 *
 * @param totalCents             Amount of the expense, in cents.
 * @param percentagesBasisPoints Percentage per participant, in basis points.
 * @returns One share per participant, in cents, summing exactly to totalCents.
 */
export function splitByPercentages(
  totalCents: number,
  percentagesBasisPoints: readonly number[],
): number[] {
  if (percentagesBasisPoints.length === 0) {
    throw new Error('percentagesBasisPoints must contain at least one participant');
  }

  percentagesBasisPoints.forEach((basisPoints, index) =>
    assertBasisPoints(basisPoints, `percentagesBasisPoints[${index}]`),
  );

  assertPercentagesAddUpToFull(percentagesBasisPoints);

  return distributeProportionally(totalCents, percentagesBasisPoints);
}

function assertBasisPoints(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(
      `${label} must be a whole number of basis points (1% = 100), got ${value}`,
    );
  }
  if (value < 0) {
    throw new Error(`${label} cannot be negative, got ${value}`);
  }
}

function assertPercentagesAddUpToFull(
  percentagesBasisPoints: readonly number[],
): void {
  const assigned = sumIntegers(percentagesBasisPoints);

  if (assigned === BASIS_POINTS_IN_FULL) {
    return;
  }

  const difference = BASIS_POINTS_IN_FULL - assigned;
  const problem =
    difference > 0
      ? `${formatBasisPoints(difference)} short`
      : `${formatBasisPoints(-difference)} over`;

  throw new Error(
    `percentages must add up to 100%, but they add up to ` +
      `${formatBasisPoints(assigned)}: ${problem}`,
  );
}

function formatBasisPoints(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}
