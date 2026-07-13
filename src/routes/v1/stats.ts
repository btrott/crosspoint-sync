import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { nowSeconds } from '../../models/sync.js';
import {
  combineBookStats,
  combineGlobalStats,
  parseBookStats,
  parseGlobalStats,
  type BookStatsSnapshot,
  type GlobalStatsSnapshot,
} from '../../models/stats.js';

const MAX_BOOK_BATCH = 20;

function deviceIdFrom(o: Record<string, unknown>): string | null {
  return typeof o.device_id === 'string' && o.device_id.length > 0 && o.device_id.length <= 128
    ? o.device_id
    : null;
}

export function statsRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put('/stats/global', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const deviceId = deviceIdFrom(o);
    const snapshot = parseGlobalStats(o);
    if (!deviceId || !snapshot) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const device = typeof o.device === 'string' ? o.device.slice(0, 128) : '';
    const user = c.get('user');
    const now = nowSeconds();
    db.prepare(
      `INSERT INTO stats_device_global (user_id, device_id, device, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET
         device = excluded.device,
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    ).run(user.id, deviceId, device, JSON.stringify(snapshot), now);
    return c.json({ until: now });
  });

  app.put('/stats/books', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const deviceId = deviceIdFrom(o);
    const items = o.items;
    if (!deviceId || !Array.isArray(items) || items.length === 0 || items.length > MAX_BOOK_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const parsed: { document: string; snapshot: BookStatsSnapshot }[] = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const snapshot = parseBookStats(item);
      if (!isValidDocument(item.document) || !snapshot) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      parsed.push({ document: item.document, snapshot });
    }
    const user = c.get('user');
    const now = nowSeconds();
    const upsert = db.prepare(
      `INSERT INTO stats_device_book (user_id, device_id, document, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, device_id, document) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    );
    withTransaction(db, () => {
      for (const p of parsed) {
        upsert.run(user.id, deviceId, p.document, JSON.stringify(p.snapshot), now);
      }
    });
    return c.json({ until: now, accepted: parsed.length });
  });

  app.get('/stats/global', (c) => {
    const user = c.get('user');
    const rows = db
      .prepare(
        'SELECT device_id, device, payload, updated_at FROM stats_device_global WHERE user_id = ?'
      )
      .all(user.id) as { device_id: string; device: string; payload: string; updated_at: number }[];
    return c.json({
      devices: rows.map((r) => ({
        device_id: r.device_id,
        device: r.device,
        updated_at: r.updated_at,
        stats: JSON.parse(r.payload),
      })),
    });
  });

  app.get('/stats/summary', (c) => {
    const user = c.get('user');
    const rows = db
      .prepare(
        'SELECT device_id, device, payload, updated_at FROM stats_device_global WHERE user_id = ?'
      )
      .all(user.id) as { device_id: string; device: string; payload: string; updated_at: number }[];
    const snapshots = rows.map((r) => JSON.parse(r.payload) as GlobalStatsSnapshot);
    const summary = combineGlobalStats(snapshots);
    return c.json({
      ...summary,
      devices: rows.map((r) => ({
        device_id: r.device_id,
        device: r.device,
        updated_at: r.updated_at,
      })),
    });
  });

  app.get('/stats/books/:document', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const rows = db
      .prepare(
        `SELECT device_id, payload, updated_at FROM stats_device_book
         WHERE user_id = ? AND document = ?`
      )
      .all(user.id, document) as { device_id: string; payload: string; updated_at: number }[];
    const snapshots = rows.map((r) => JSON.parse(r.payload) as BookStatsSnapshot);
    return c.json({
      document,
      combined: combineBookStats(snapshots),
      devices: rows.map((r) => ({
        device_id: r.device_id,
        updated_at: r.updated_at,
        stats: JSON.parse(r.payload),
      })),
    });
  });

  return app;
}
