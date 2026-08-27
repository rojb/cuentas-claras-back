import express, { type Express } from 'express';
import type { Database } from '../db/pool.js';
import type { TokenSettings } from '../../application/auth/tokens.js';
import { cors } from './cors.js';
import { handleErrors, routeNotFound } from './errors.js';
import { authRoutes } from './routes/auth-routes.js';
import { groupRoutes } from './routes/group-routes.js';

/**
 * Builds the HTTP app.
 *
 * It takes its dependencies as arguments instead of importing a global pool,
 * so the app can be pointed at a different database without changing a line
 * in here.
 */
export function createApp(
  db: Database,
  tokens: TokenSettings,
  webOrigins: readonly string[] = [],
): Express {
  const app = express();

  // First in the chain. A preflight carries no body worth parsing and no
  // token to check, and it has to be answered before anything can reject it.
  app.use(cors(webOrigins));

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/auth', authRoutes(db, tokens));
  app.use('/groups', groupRoutes(db, tokens));

  // Order matters: unknown routes first, then the error handler last, so
  // everything thrown anywhere above lands in one place.
  app.use(routeNotFound);
  app.use(handleErrors);

  return app;
}
