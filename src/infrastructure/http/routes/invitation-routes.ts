import { Router } from 'express';
import type { Database } from '../../db/pool.js';
import type { TokenSettings } from '../../../application/auth/tokens.js';
import {
  acceptInvitation,
  listMyInvitations,
  rejectInvitation,
} from '../../../application/groups/respond-to-invitation.js';
import { authenticate, currentUser } from '../authenticate.js';
import { readUuid } from '../params.js';

/**
 * The invitations addressed to whoever is asking.
 *
 * Mounted at the top level and not under /groups on purpose: you cannot read
 * a group you are not in yet, so an invitation to it cannot live behind a
 * URL that already requires membership. These are yours, not the group's.
 */
export function invitationRoutes(db: Database, tokens: TokenSettings): Router {
  const routes = Router();

  routes.use(authenticate(tokens));

  const readInvitationId = (value: unknown): string =>
    readUuid(value, 'invitation');

  routes.get('/', async (req, res) => {
    res.json({
      invitations: await listMyInvitations(db, currentUser(req).userId),
    });
  });

  // POST and not PUT: answering is not idempotent in the way a PUT promises.
  // The second attempt does not overwrite the first, it is refused — the
  // answer already happened and it is not up for revision.
  routes.post('/:invitationId/accept', async (req, res) => {
    const invitationId = readInvitationId(req.params.invitationId);

    const { group } = await acceptInvitation(
      db,
      invitationId,
      currentUser(req).userId,
    );

    // The group comes back so the app can take somebody straight into it
    // instead of making them go and look for what they just joined.
    res.json({ group });
  });

  routes.post('/:invitationId/reject', async (req, res) => {
    const invitationId = readInvitationId(req.params.invitationId);

    await rejectInvitation(db, invitationId, currentUser(req).userId);

    res.status(204).end();
  });

  return routes;
}
