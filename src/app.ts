import { Hono } from 'hono';
import type { DB } from './db/db.js';
import type { Config } from './config.js';
import { authMiddleware, type AppEnv } from './auth/middleware.js';
import { kosyncRoutes } from './routes/kosync.js';
import { progressRoutes } from './routes/v1/progress.js';
import { bookmarkRoutes } from './routes/v1/bookmarks.js';
import { clippingRoutes } from './routes/v1/clippings.js';
import { statsRoutes } from './routes/v1/stats.js';
import { documentRoutes } from './routes/v1/documents.js';
import { connectorRoutes } from './routes/v1/connectors.js';
import type { HttpTransport } from './connectors/types.js';

// Injected at build time via package.json; read lazily to keep this file dependency-free.
export const VERSION = process.env.npm_package_version ?? '0.1.0';

export interface AppOptions {
  /** Override the connector HTTP transport (tests inject a fake). */
  connectorTransport?: HttpTransport;
}

export function createApp(db: DB, config: Config, opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/healthz', (c) => c.json({ status: 'ok', version: VERSION }));

  // kosync-compatible API at the root — stock KOReader and current CrossPoint
  // firmware work by changing only the server URL.
  app.route('/', kosyncRoutes(db, config));

  // Extended CrossPoint API; same auth headers.
  const v1 = new Hono<AppEnv>();
  v1.use('*', authMiddleware(db));
  v1.route('/', progressRoutes(db));
  v1.route('/', bookmarkRoutes(db));
  v1.route('/', clippingRoutes(db));
  v1.route('/', statsRoutes(db));
  v1.route('/', documentRoutes(db));
  v1.route('/', connectorRoutes(db, opts.connectorTransport));
  app.route('/api/v1', v1);

  return app;
}
