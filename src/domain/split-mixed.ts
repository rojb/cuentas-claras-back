import { splitEqually } from './split-equally.js';
import { assertAmountCents, sumIntegers } from './money.js';

/**
 * What a single participant contributes in a mixed split: either a fixed
 * amount they agreed to put in, or an equal cut of whatever is left.
 */
export type MixedPart =
  | { readonly kind: 'exact'; readonly amountCents: number }
  | { readonly kind: 'rest' };

/** "I put in exactly $50 and I am done." */
export function exactly(amountCents: number): MixedPart {
  return { kind: 'exact', amountCents };
}

/** "Split whatever is left between me and the others." */
export const REST: MixedPart = { kind: 'rest' };

/**
 * Splits an amount where some participants put in a fixed amount and the
 * others share what remains, equally.
 *
 * This is how uneven expenses usually get settled out loud: "the parents put
 * in $5000, the rest of us split what's missing". Nobody wants to compute
 * percentages for that.
 *
 * @param totalCents Amount of the expense, in cents.
 * @param parts      One entry per participant, in participant order.
 * @returns One share per participant, in cents, summing exactly to totalCents.
 */
export function splitMixed(
  totalCents: number,
  parts: readonly MixedPart[],
): number[] {
  assertAmountCents(totalCents, 'totalCents');

  if (parts.length === 0) {
    throw new Error('parts must contain at least one participant');
  }

  parts.forEach((part, index) => {
    if (part.kind === 'exact') {
      assertAmountCents(part.amountCents, `parts[${index}].amountCents`);
    }
  });

  const fixedCents = sumIntegers(
    parts.map((part) => (part.kind === 'exact' ? part.amountCents : 0)),
  );

  if (fixedCents > totalCents) {
    throw new Error(
      `the fixed amounts add up to ${fixedCents}, which is more than ` +
        `totalCents (${totalCents}): ${fixedCents - totalCents} cents too many`,
    );
  }

  const remainingCents = totalCents - fixedCents;
  const participantsSharingTheRest = parts.filter(
    (part) => part.kind === 'rest',
  ).length;

  // Nobody left to absorb the difference: then the fixed amounts had better
  // be the whole expense, or the split simply does not add up.
  if (participantsSharingTheRest === 0) {
    if (remainingCents > 0) {
      throw new Error(
        `the fixed amounts add up to ${fixedCents} but totalCents is ` +
          `${totalCents}, and no participant is set to cover the remaining ` +
          `${remainingCents} cents`,
      );
    }
    return parts.map((part) => (part.kind === 'exact' ? part.amountCents : 0));
  }

  const pendingShares = splitEqually(remainingCents, participantsSharingTheRest);

  return parts.map((part) =>
    part.kind === 'exact' ? part.amountCents : (pendingShares.shift() ?? 0),
  );
}
