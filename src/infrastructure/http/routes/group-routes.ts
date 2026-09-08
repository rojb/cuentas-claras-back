import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import type { TokenSettings } from '../../../application/auth/tokens.js';
import { createGroup } from '../../../application/groups/create-group.js';
import { inviteGroupMember } from '../../../application/groups/invite-group-member.js';
import { listGroupPendingGuests } from '../../../application/groups/respond-to-invitation.js';
import { leaveGroup } from '../../../application/groups/leave-group.js';
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

// No currency: a group settles in USDT and its expenses carry their own.
const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const inviteSchema = z.object({
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

  // There is no POST /:groupId/members any more, and that is the point.
  // Nobody puts somebody else in a group: you ask, and they answer.
  routes.post('/:groupId/invitations', validateBody(inviteSchema), async (req, res) => {
    const groupId = readGroupId(req.params.groupId);
    const input = validatedBody<z.infer<typeof inviteSchema>>(req);

    const result = await inviteGroupMember(
      db,
      groupId,
      currentUser(req).userId,
      input,
    );

    // 201 when the question is new, 200 when it was already open.
    res.status(result.created ? 201 : 200).json({
      invitation: result.invitation,
      invitee: result.invitee,
    });
  });

  /** Who has been asked and has not answered yet. */
  routes.get('/:groupId/invitations', async (req, res) => {
    const groupId = readGroupId(req.params.groupId);

    res.json({
      invitations: await listGroupPendingGuests(
        db,
        groupId,
        currentUser(req).userId,
      ),
    });
  });

  // "me" and not an :userId, because this endpoint does one thing and it is
  // not kicking people out. A path that reads /members/:userId invites the
  // question of who else you are allowed to name, and the answer here is
  // nobody. 204: it worked, and there is nothing left to say about it.
  routes.delete('/:groupId/members/me', async (req, res) => {
    const groupId = readGroupId(req.params.groupId);

    await leaveGroup(db, groupId, currentUser(req).userId);

    res.status(204).end();
  });

  return routes;
}
