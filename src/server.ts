import { loadEnvironment } from './config/environment.js';
import { createPool } from './infrastructure/db/pool.js';
import { createApp } from './infrastructure/http/app.js';

const environment = loadEnvironment();

const db = createPool(environment.DATABASE_URL);

const app = createApp(
  db,
  {
    secret: environment.JWT_SECRET,
    expiresInSeconds: environment.JWT_EXPIRES_IN_SECONDS,
  },
  environment.WEB_ORIGINS,
);

const server = app.listen(environment.PORT, () => {
  console.log(`listening on http://localhost:${environment.PORT}`);
});

/**
 * Docker and Ctrl-C both send SIGTERM/SIGINT. Finish the requests already in
 * flight and hand the database connections back before leaving.
 */
const shutDown = (signal: string): void => {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    void db.end().then(() => process.exit(0));
  });
};

process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));
