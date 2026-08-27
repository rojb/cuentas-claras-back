import { distributeProportionally } from './distribute-proportionally.js';
import { sumIntegers } from './money.js';

/**
 * Splits an amount by shares — "parts" of the expense.
 *
 * This is how people actually talk when the split is uneven but nobody wants
 * to do arithmetic: on a beach house, the couple in the double room takes
 * 2 shares and each single takes 1. The user never has to work out that this
 * means 50% / 25% / 25%.
 *
 * Unlike percentages, shares do NOT have to add up to anything in particular.
 * They are relative weights: 2/1/1 and 4/2/2 split the money identically.
 * The only thing that would make no sense is everybody taking zero shares.
 *
 * @param totalCents Amount of the expense, in cents.
 * @param shares     Number of shares per participant. Whole and non-negative.
 * @returns One share per participant, in cents, summing exactly to totalCents.
 */
export function splitByShares(
  totalCents: number,
  shares: readonly number[],
): number[] {
  if (shares.length === 0) {
    throw new Error('shares must contain at least one participant');
  }

  shares.forEach((share, index) => assertShareCount(share, `shares[${index}]`));

  if (sumIntegers(shares) === 0) {
    throw new Error('shares must add up to more than zero: someone has to pay');
  }

  return distributeProportionally(totalCents, shares);
}

function assertShareCount(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number of shares, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`${label} cannot be negative, got ${value}`);
  }
}
