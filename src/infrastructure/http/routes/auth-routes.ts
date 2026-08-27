import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import type { TokenSettings } from '../../../application/auth/tokens.js';
import { registerUser } from '../../../application/auth/register-user.js';
import { logInUser } from '../../../application/auth/log-in-user.js';
import { validateBody, validatedBody } from '../validate.js';
import { authenticate, currentUser } from '../authenticate.js';
import { notFound } from '../errors.js';

const registerSchema = z.object({
  email: z.email(),
  // Length beats forced symbols: "caballo correcto batería grapa" is a far
  // better password than "P4ss!" and much easier to remember.
  password: z.string().min(10).max(200),
  displayName: z.string().trim().min(1).max(80),
});

const logInSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});

export function authRoutes(db: Database, tokens: TokenSettings): Router {
  const routes = Router();

  routes.post('/register', validateBody(registerSchema), async (req, res) => {
    const input = validatedBody<z.infer<typeof registerSchema>>(req);
    res.status(201).json(await registerUser(db, tokens, input));
  });

  routes.post('/login', validateBody(logInSchema), async (req, res) => {
    const input = validatedBody<z.infer<typeof logInSchema>>(req);
    res.json(await logInUser(db, tokens, input));
  });

  routes.get('/me', authenticate(tokens), async (req, res) => {
    const { rows } = await db.query<{
      id: string;
      email: string;
      displayName: string;
    }>(
      `SELECT id, email, display_name AS "displayName" FROM users WHERE id = $1`,
      [currentUser(req).userId],
    );

    const user = rows[0];
    if (user === undefined) {
      // A valid token for a user that no longer exists.
      throw notFound('user_not_found', 'that user no longer exists');
    }

    res.json({ user });
  });

  return routes;
}
