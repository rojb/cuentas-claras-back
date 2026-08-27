import { assertAmountCents, sumIntegers } from './money.js';
import { distributeProportionally } from './distribute-proportionally.js';
import { splitEqually } from './split-equally.js';
import { splitByExactAmounts } from './split-by-exact-amounts.js';
import { splitByPercentages } from './split-by-percentages.js';
import { splitByShares } from './split-by-shares.js';
import { splitMixed, type MixedPart } from './split-mixed.js';

export type ParticipantId = string;

/**
 * How a single item is divided between the people who took part in it.
 *
 * The first five delegate to the split functions we already have. The last
 * one is different: see `proportionalToConsumption` below.
 */
export type ItemSplit =
  | { readonly kind: 'equally' }
  | { readonly kind: 'exactAmounts'; readonly amountsCents: readonly number[] }
  | {
      readonly kind: 'percentages';
      readonly percentagesBasisPoints: readonly number[];
    }
  | { readonly kind: 'shares'; readonly shares: readonly number[] }
  | { readonly kind: 'mixed'; readonly parts: readonly MixedPart[] }
  /**
   * For tips, service charges, delivery fees: things nobody ordered, that
   * are fair to charge in proportion to what each person actually consumed.
   * It cannot be worked out on its own — it needs every other item resolved
   * first — so it is calculated in a second pass.
   */
  | { readonly kind: 'proportionalToConsumption' };

/**
 * One line of a bill: what it was, what it cost, who was in on it, and how
 * they divided it. An item is really just a small expense of its own.
 */
export interface ExpenseItem {
  readonly description: string;
  readonly amountCents: number;
  readonly participants: readonly ParticipantId[];
  readonly split: ItemSplit;
}

/** What one person ends up owing for the whole expense. */
export interface ParticipantShare {
  readonly participantId: ParticipantId;
  readonly amountCents: number;
}

/**
 * Works out what each person owes for an expense made of several items.
 *
 *   Burger  $12  -> Juan
 *   Pizza   $20  -> Juan, Ana
 *   Drinks  $15  -> Juan, Ana, Beto
 *   Tip      $6  -> proportional to what each of them consumed
 *
 * Each item is divided on its own, and a person's share of the expense is
 * the sum of their share of every item they took part in. Somebody who was
 * not in on an item simply does not appear in it.
 *
 * @param items The lines of the bill. At least one.
 * @returns One entry per participant, in the order they first appear,
 *          adding up exactly to the sum of all item amounts.
 */
export function splitByItems(items: readonly ExpenseItem[]): ParticipantShare[] {
  if (items.length === 0) {
    throw new Error('an expense must have at least one item');
  }

  items.forEach((item, index) => assertValidItem(item, `items[${index}]`));

  const owedByParticipant = new Map<ParticipantId, number>();
  const orderOfAppearance: ParticipantId[] = [];

  for (const item of items) {
    for (const participantId of item.participants) {
      if (!owedByParticipant.has(participantId)) {
        owedByParticipant.set(participantId, 0);
        orderOfAppearance.push(participantId);
      }
    }
  }

  // First pass: every item that can stand on its own.
  const surcharges: ExpenseItem[] = [];

  for (const item of items) {
    if (item.split.kind === 'proportionalToConsumption') {
      surcharges.push(item);
      continue;
    }
    addShares(owedByParticipant, item, resolveItemShares(item));
  }

  // Second pass: tips and the like, weighted by what each person consumed.
  for (const item of surcharges) {
    const consumedByParticipant = item.participants.map(
      (participantId) => owedByParticipant.get(participantId) ?? 0,
    );

    // If nobody consumed anything yet (a bill that is only a tip), there is
    // no proportion to respect, so the fair fallback is an equal split.
    const shares =
      sumIntegers(consumedByParticipant) > 0
        ? distributeProportionally(item.amountCents, consumedByParticipant)
        : splitEqually(item.amountCents, item.participants.length);

    addShares(owedByParticipant, item, shares);
  }

  return orderOfAppearance.map((participantId) => ({
    participantId,
    amountCents: owedByParticipant.get(participantId) ?? 0,
  }));
}

/** The expense total implied by its items. */
export function sumItemAmounts(items: readonly ExpenseItem[]): number {
  return sumIntegers(items.map((item) => item.amountCents));
}

function resolveItemShares(item: ExpenseItem): number[] {
  const { amountCents, participants, split } = item;

  switch (split.kind) {
    case 'equally':
      return splitEqually(amountCents, participants.length);

    case 'exactAmounts':
      return splitByExactAmounts(amountCents, split.amountsCents);

    case 'percentages':
      return splitByPercentages(amountCents, split.percentagesBasisPoints);

    case 'shares':
      return splitByShares(amountCents, split.shares);

    case 'mixed':
      return splitMixed(amountCents, split.parts);

    case 'proportionalToConsumption':
      // Handled in the second pass; never reaches here.
      throw new Error(
        'proportionalToConsumption items must be resolved after every other item',
      );
  }
}

function addShares(
  owedByParticipant: Map<ParticipantId, number>,
  item: ExpenseItem,
  shares: readonly number[],
): void {
  item.participants.forEach((participantId, index) => {
    const alreadyOwed = owedByParticipant.get(participantId) ?? 0;
    owedByParticipant.set(participantId, alreadyOwed + (shares[index] ?? 0));
  });
}

function assertValidItem(item: ExpenseItem, label: string): void {
  assertAmountCents(item.amountCents, `${label}.amountCents`);

  if (item.description.trim() === '') {
    throw new Error(`${label}.description cannot be empty`);
  }

  if (item.participants.length === 0) {
    throw new Error(`${label} must have at least one participant`);
  }

  const distinctParticipants = new Set(item.participants);
  if (distinctParticipants.size !== item.participants.length) {
    throw new Error(
      `${label} lists the same participant more than once, so they would be charged twice`,
    );
  }

  assertSplitMatchesParticipants(item, label);
}

/**
 * Positional splits describe participants by position, so a list of the
 * wrong length would silently charge the wrong people.
 */
function assertSplitMatchesParticipants(item: ExpenseItem, label: string): void {
  const expected = item.participants.length;
  const { split } = item;

  const given =
    split.kind === 'exactAmounts'
      ? split.amountsCents.length
      : split.kind === 'percentages'
        ? split.percentagesBasisPoints.length
        : split.kind === 'shares'
          ? split.shares.length
          : split.kind === 'mixed'
            ? split.parts.length
            : expected;

  if (given !== expected) {
    throw new Error(
      `${label}.split describes ${given} participants but the item has ${expected}`,
    );
  }
}
