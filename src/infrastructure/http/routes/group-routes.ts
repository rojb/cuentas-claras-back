import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import type { TokenSettings } from '../../../application/auth/tokens.js';
import { createGroup } from '../../../application/groups/create-group.js';
import { addGroupMember } from '../../../application/groups/add-group-member.js';
import { requireMembership } from '../../../application/groups/membership.js';
import {
  listGroupMembers,
  listGroupsForUser,
} from '../../db/groups-repository.js';
import { validateBody, validatedBody } from '../validate.js';
import { authenticate, currentUser } from '../authenticate.js';
import { readUuid } from '../params.js';
import { expenseRoutes } from './expense-routes.js';
import { paymentRoutes } from './payment-routes.js';
import {
  calculateGroupBalances,
  calculateGroupSettlement,
} from '../../../application/balances/read-ledger.js';

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // ISO 4217, upper-cased for us so "ars" and "ARS" are the same group.
  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code, like ARS or USD'),
});

const addMemberSchema = z.object({
  email: z.email(),
});

const readGroupId = (value: unknown): string => readUuid(value, 'group');

export function groupRoutes(db: Database, tokens: TokenSettings): Router {
  const routes = Router();

  // Everything below belongs to somebody. No anonymous access, ever.
  routes.use(authenticate(tokens));

  // Expenses live inside a group and nowhere else, so their URLs say so.
  // authenticate() above already covers them.
  routes.use('/:groupId/expenses', expenseRoutes(db));
  routes.use('/:groupId/payments', paymentRoutes(db));

  // Derived, never stored. Every request recomputes them from the ledger,
  // which is exactly why they can never drift out of date.
  routes.get('/:groupId/balances', async (req, res) => {
    const groupId = readGroupId(req.params.groupId);
    const balances = await calculateGroupBalances(
      db,
      groupId,
      currentUser(req).userId,
    );

    res.json({
      balances: balances.map((balance) => ({
        userId: balance.participantId,
        balanceCents: balance.balanceCents,
      })),
    });
  });

  routes.get('/:groupId/settlement', async (req, res) => {
    const groupId = readGroupId(req.params.groupId);
    const transfers = await calculateGroupSettlement(
      db,
      groupId,
      currentUser(req).userId,
    );

    res.json({
      transfers: transfers.map((transfer) => ({
        fromUser: transfer.fromParticipant,
        toUser: transfer.toParticipant,
        amountCents: transfer.amountCents,
      })),
    });
  });

  routes.post('/', validateBody(createGroupSchema), async (req, res) => {
    const input = validatedBody<z.infer<typeof createGroupSchema>>(req);
    res.status(201).json(await createGroup(db, currentUser(req).userId, input));
  });

  routes.get('/', async (req, res) => {
    res.json({ groups: await listGroupsForUser(db, currentUser(req).userId) });
  });

  routes.get('/:groupId', async (req, res) => {
    const groupId = readGroupId(req.params.groupId);
    const group = await requireMembership(db, groupId, currentUser(req).userId);

    res.json({ group, members: await listGroupMembers(db, groupId) });
  });

  routes.get('/:groupId/members', async (req, res) => {
    const groupId = readGroupId(req.params.groupId);
    await requireMembership(db, groupId, currentUser(req).userId);

    res.json({ members: await listGroupMembers(db, groupId) });
  });

  routes.post('/:groupId/members', validateBody(addMemberSchema), async (req, res) => {
    const groupId = readGroupId(req.params.groupId);
    const input = validatedBody<z.infer<typeof addMemberSchema>>(req);

    const result = await addGroupMember(db, groupId, currentUser(req).userId, input);

    // 201 when the membership is new, 200 when they were already in.
    res.status(result.added ? 201 : 200).json({ member: result.member });
  });

  return routes;
}
