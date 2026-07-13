import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { fromEnv } from './config.js';
import { migrate, openDatabase } from './db/db.js';

const DATABASE_PATH = process.env.DATABASE_PATH ?? '/data/crosspoint.db';
const PORT = Number(process.env.PORT ?? 8080);

const db = openDatabase(DATABASE_PATH);
migrate(db);

const app = createApp(db, fromEnv());

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    JSON.stringify({
      msg: 'crosspoint-sync listening',
      port: info.port,
      db: DATABASE_PATH,
    })
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    db.close();
    process.exit(0);
  });
}
