import { assertAmountCents, assertPositiveInteger } from './money.js';

/**
 * Splits an amount equally between a number of people.
 *
 * When the amount does not divide evenly, the leftover cents are handed
 * out one by one to the first participants, so the result always adds up
 * to exactly `totalCents` and no two shares differ by more than one cent.
 *
 * @param totalCents Amount to split, in cents. Non-negative whole number.
 * @param people     Number of participants. Whole number greater than zero.
 * @returns One share per participant, in cents, summing exactly to totalCents.
 */
export function splitEqually(totalCents: number, people: number): number[] {
  assertAmountCents(totalCents, 'totalCents');
  assertPositiveInteger(people, 'people');

  const base = Math.floor(totalCents / people);
  const leftoverCents = totalCents - base * people;

  return Array.from({ length: people }, (_, index) =>
    index < leftoverCents ? base + 1 : base,
  );
}
