import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import {
  deletePayment,
  listGroupPayments,
  recordPayment,
} from '../../../application/payments/record-payment.js';
import { validateBody, validatedBody } from '../validate.js';
import { currentUser } from '../authenticate.js';
import { pathParams, readUuid } from '../params.js';
import type { GroupEvents } from '../../events/group-events.js';
import { currencyCode, rateMicros } from './money-schema.js';

const recordPaymentSchema = z.object({
  fromUser: z.uuid().optional(),
  toUser: z.uuid(),
  // A debt is in USDT; settling it is not obliged to be. Handing somebody
  // Bs 348 to cover 50 USDT is a normal thing to do, and the rate is what
  // says the two are the same payment.
  amountCents: z.int().positive(),
  currencyCode,
  rateMicros,
  paidAt: z.iso.datetime().optional(),
});

/** Mounted under /groups/:groupId, so it needs the parent's params. */
export function paymentRoutes(db: Database, events: GroupEvents): Router {
  const routes = Router({ mergeParams: true });

  routes.post('/', validateBody(recordPaymentSchema), async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');
    const input = validatedBody<z.infer<typeof recordPaymentSchema>>(req);

    const actorId = currentUser(req).userId;
    const recorded = await recordPayment(db, groupId, actorId, input);

    // The event this whole stream was built for. Somebody being told their
    // debt was just settled, without having to pull down to find out, is the
    // difference between a ledger and an app.
    events.publish({ kind: 'payment.recorded', groupId, actorId });

    res.status(201).json(recorded);
  });

  routes.get('/', async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');

    res.json({
      payments: await listGroupPayments(db, groupId, currentUser(req).userId),
    });
  });

  routes.delete('/:paymentId', async (req, res) => {
    const groupId = readUuid(pathParams(req).groupId, 'group');
    const paymentId = readUuid(pathParams(req).paymentId, 'payment');

    const actorId = currentUser(req).userId;
    await deletePayment(db, groupId, paymentId, actorId);

    events.publish({ kind: 'payment.deleted', groupId, actorId });

    res.status(204).end();
  });

  return routes;
}
