import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import { createExpense } from '../../../application/expenses/create-expense.js';
import {
  deleteExpense,
  getExpense,
  listGroupExpenses,
} from '../../../application/expenses/list-expenses.js';
import { replaceExpense } from '../../../application/expenses/replace-expense.js';
import { validateBody, validatedBody } from '../validate.js';
import { currentUser } from '../authenticate.js';
import { pathParams, readUuid } from '../params.js';
import type { GroupEvents } from '../../events/group-events.js';
import { currencyCode, rateMicros } from './money-schema.js';

const userId = z.uuid();
const cents = z.int().nonnegative();

/**
 * Every number travels attached to the person it belongs to.
 *
 * The domain divides positionally — percentages[0] belongs to participants[0]
 * — but asking a client to keep two lists aligned is asking for the day
 * somebody inserts a participant and silently charges the wrong person.
 */
const equally = z.object({
  kind: z.literal('equally'),
  participants: z.array(userId).min(1),
});

const exactAmounts = z.object({
  kind: z.literal('exactAmounts'),
  participants: z.array(z.object({ userId, amountCents: cents })).min(1),
});

const percentages = z.object({
  kind: z.literal('percentages'),
  participants: z
    .array(
      z.object({
        userId,
        // Basis points: 3333 is 33.33%. Percentages with decimals are not
        // representable as integers, and floating point has no business
        // anywhere near money.
        percentageBasisPoints: z.int().min(0).max(10_000),
      }),
    )
    .min(1),
});

const shares = z.object({
  kind: z.literal('shares'),
  participants: z
    .array(z.object({ userId, shares: z.int().nonnegative() }))
    .min(1),
});

const mixed = z.object({
  kind: z.literal('mixed'),
  // No amountCents means "and the rest, split between whoever is left".
  participants: z
    .array(z.object({ userId, amountCents: cents.optional() }))
    .min(1),
});

const proportionalToConsumption = z.object({
  kind: z.literal('proportionalToConsumption'),
  participants: z.array(userId).min(1),
});

const itemSplit = z.discriminatedUnion('kind', [
  equally,
  exactAmounts,
  percentages,
  shares,
  mixed,
  proportionalToConsumption,
]);

const item = z.object({
  description: z.string().trim().min(1).max(120),
  amountCents: z.int().positive(),
  split: itemSplit,
});

// An item cannot itself be made of items; an expense cannot be a surcharge
// on nothing. Two unions instead of one is what keeps both true.
const split = z.discriminatedUnion('kind', [
  equally,
  exactAmounts,
  percentages,
  shares,
  mixed,
  z.object({ kind: z.literal('items'), items: z.array(item).min(1).max(200) }),
]);

const createExpenseSchema = z.object({
  description: z.string().trim().min(1).max(120),
  // In currencyCode. Every amount inside `split` is in it too: the split is
  // what the people agreed to, and they agreed to it in the money they were
  // holding. Converting to USDT happens once, afterwards, on the total.
  totalCents: z.int().positive(),
  currencyCode,
  rateMicros,
  paidBy: userId.optional(),
  spentAt: z.iso.datetime().optional(),
  split,
});

/** Mounted under /groups/:groupId, so it needs the parent's params. */
export function expenseRoutes(db: Database, events: GroupEvents): Router {
  const routes = Router({ mergeParams: true });

  routes.post('/', validateBody(createExpenseSchema), async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');
    const input = validatedBody<z.infer<typeof createExpenseSchema>>(req);

    const actorId = currentUser(req).userId;
    const created = await createExpense(db, groupId, actorId, input);

    // Announced only once the write has come back, which means the
    // transaction committed. Telling four phones to reload because of an
    // expense that then rolled back would have them all fetch the same
    // nothing.
    events.publish({ kind: 'expense.created', groupId, actorId });

    res.status(201).json(created);
  });

  routes.get('/', async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');

    res.json({
      expenses: await listGroupExpenses(db, groupId, currentUser(req).userId),
    });
  });

  routes.get('/:expenseId', async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');
    const expenseId = readUuid(pathParams(req).expenseId, 'expense');

    res.json(await getExpense(db, groupId, expenseId, currentUser(req).userId));
  });

  // PUT, not PATCH: the body is a whole expense, and the split has to be
  // read as one thing. Half a split — new percentages, old participants — is
  // not a smaller edit, it is an expense that does not add up.
  routes.put('/:expenseId', validateBody(createExpenseSchema), async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');
    const expenseId = readUuid(pathParams(req).expenseId, 'expense');
    const input = validatedBody<z.infer<typeof createExpenseSchema>>(req);

    const actorId = currentUser(req).userId;
    const replaced = await replaceExpense(db, groupId, expenseId, actorId, input);

    events.publish({ kind: 'expense.replaced', groupId, actorId });

    res.json(replaced);
  });

  routes.delete('/:expenseId', async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');
    const expenseId = readUuid(pathParams(req).expenseId, 'expense');

    const actorId = currentUser(req).userId;
    await deleteExpense(db, groupId, expenseId, actorId);

    events.publish({ kind: 'expense.deleted', groupId, actorId });

    res.status(204).end();
  });

  return routes;
}
