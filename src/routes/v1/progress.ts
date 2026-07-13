import { Hono } from 'hono';
import type { DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument, parseProgressBody, upsertProgress } from '../kosync.js';

export function progressRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put('/progress', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const parsed = parseProgressBody(user.id, body);
    if (!parsed.ok) {
      return kosyncError(c, 403, parsed.code, parsed.message);
    }
    upsertProgress(db, parsed.record);
    return c.json({ document: parsed.record.document, timestamp: parsed.record.updatedAt });
  });

  app.get('/progress/:document', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const rows = db
      .prepare(
        `SELECT device_id, device, percentage, progress, position, updated_at
         FROM progress WHERE user_id = ? AND document = ?
         ORDER BY updated_at DESC, device_id`
      )
      .all(user.id, document) as {
      device_id: string;
      device: string;
      percentage: number;
      progress: string;
      position: string | null;
      updated_at: number;
    }[];
    return c.json({
      document,
      devices: rows.map((r) => ({
        device_id: r.device_id,
        device: r.device,
        percentage: r.percentage,
        progress: r.progress,
        position: r.position ? JSON.parse(r.position) : null,
        timestamp: r.updated_at,
      })),
    });
  });

  return app;
}
