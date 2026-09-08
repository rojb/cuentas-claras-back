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
import type { GroupEvents } from '../../events/group-events.js';
import { eventRoutes } from './event-routes.js';
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

export function groupRoutes(
  db: Database,
  tokens: TokenSettings,
  events: GroupEvents,
): Router {
  const routes = Router();

  // BEFORE the authenticate() below, and that ordering is the whole reason
  // this line is here and not with the others. The event stream needs the
  // variant that also reads a token from the query string, because
  // EventSource cannot send a header; registering it first lets it bring its
  // own gate instead of being turned away by the strict one.
  routes.use('/:groupId/events', eventRoutes(db, tokens, events));

  // Everything below belongs to somebody. No anonymous access, ever.
  routes.use(authenticate(tokens));

  // Expenses live inside a group and nowhere else, so their URLs say so.
  // authenticate() above already covers them.
  routes.use('/:groupId/expenses', expenseRoutes(db, events));
  routes.use('/:groupId/payments', paymentRoutes(db, events));

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

    const actorId = currentUser(req).userId;
    const result = await inviteGroupMember(db, groupId, actorId, input);

    // Told to the invited person, not to the group — they cannot open the
    // group's stream until they accept, which is the whole reason a personal
    // channel exists.
    //
    // Published even when the invitation was already open and this is a
    // retry. "Nothing changed" would be the tidier signal, but the client's
    // reaction is just "reload your invitations", which is idempotent and
    // cheap — and re-announcing is what rescues somebody whose first event
    // was lost while their phone was asleep.
    events.publishToPerson(result.invitee.userId, {
      kind: 'invitation.received',
      groupId,
      actorId,
    });

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

    const actorId = currentUser(req).userId;
    await leaveGroup(db, groupId, actorId);

    // The people still in the group have one fewer name in every picker.
    events.publish({ kind: 'member.left', groupId, actorId });

    res.status(204).end();
  });

  return routes;
}
