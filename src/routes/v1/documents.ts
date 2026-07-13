import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { nowSeconds } from '../../models/sync.js';

const MAX_BATCH = 50;

export function documentRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put('/documents', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const items = (body as Record<string, unknown> | null)?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const now = nowSeconds();
    const upsert = db.prepare(
      `INSERT INTO documents (user_id, document, title, author, filesize, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, document) DO UPDATE SET
         title = excluded.title,
         author = excluded.author,
         filesize = excluded.filesize,
         updated_at = excluded.updated_at`
    );
    type Row = { document: string; title: string | null; author: string | null; filesize: number | null };
    const rows: Row[] = [];
    for (const raw of items) {
      const o = raw as Record<string, unknown>;
      if (!isValidDocument(o.document)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      rows.push({
        document: o.document,
        title: typeof o.title === 'string' ? o.title.slice(0, 512) : null,
        author: typeof o.author === 'string' ? o.author.slice(0, 512) : null,
        filesize:
          typeof o.filesize === 'number' && Number.isInteger(o.filesize) && o.filesize >= 0
            ? o.filesize
            : null,
      });
    }
    withTransaction(db, () => {
      for (const r of rows) {
        upsert.run(user.id, r.document, r.title, r.author, r.filesize, now);
      }
    });
    return c.json({ until: now, accepted: rows.length });
  });

  app.get('/documents', (c) => {
    const user = c.get('user');
    const rows = db
      .prepare(
        'SELECT document, title, author, filesize, updated_at FROM documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500'
      )
      .all(user.id);
    return c.json({ items: rows });
  });

  return app;
}
