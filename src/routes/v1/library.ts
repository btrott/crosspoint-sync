import { Hono } from 'hono';
import type { DB } from '../../db/db.js';
import { getConnector } from '../../connectors/registry.js';
import { listAccounts } from '../../connectors/store.js';
import type { AppEnv } from '../../auth/middleware.js';

type ServiceState = 'needs_match' | 'ignored' | 'matched' | 'queued' | 'synced' | 'error';

interface QueueSummary {
  pending: number;
  done: number;
  dead: number;
  last_synced_at: number | null;
  last_error: string | null;
}

/** Account-scoped, document-first overview of every linked connector. */
export function libraryRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/library', (c) => {
    const user = c.get('user');
    const accounts = listAccounts(db, user.id).sort((a, b) =>
      a.connector_id.localeCompare(b.connector_id)
    );
    const linkedIds = new Set(accounts.map((account) => account.connector_id));

    // A document can be known without metadata or progress (for example, from a
    // bookmark import, stats snapshot, saved match, or queued connector event).
    const documents = db
      .prepare(
        `WITH current_user(id) AS (VALUES (?)),
         known(document, updated_at) AS (
           SELECT document, updated_at FROM documents WHERE user_id = (SELECT id FROM current_user)
           UNION ALL
           SELECT document, updated_at FROM progress WHERE user_id = (SELECT id FROM current_user)
           UNION ALL
           SELECT document, updated_at FROM bookmarks WHERE user_id = (SELECT id FROM current_user)
           UNION ALL
           SELECT document, updated_at FROM clippings WHERE user_id = (SELECT id FROM current_user)
           UNION ALL
           SELECT document, updated_at FROM stats_device_book WHERE user_id = (SELECT id FROM current_user)
           UNION ALL
           SELECT document, updated_at FROM progress_samples WHERE user_id = (SELECT id FROM current_user)
           UNION ALL
           SELECT document, updated_at FROM connector_matches WHERE user_id = (SELECT id FROM current_user)
           UNION ALL
           SELECT document, updated_at FROM connector_queue WHERE user_id = (SELECT id FROM current_user)
         ),
         inventory AS (
           SELECT document, MAX(updated_at) AS updated_at FROM known GROUP BY document
         ),
         latest_progress AS (
           SELECT document, percentage, updated_at,
                  ROW_NUMBER() OVER (PARTITION BY document ORDER BY updated_at DESC, device_id) AS rank
           FROM progress WHERE user_id = (SELECT id FROM current_user)
         )
         SELECT i.document, d.title, d.author, d.filename,
                p.percentage, p.updated_at AS progress_updated_at, i.updated_at
         FROM inventory i
         LEFT JOIN documents d
           ON d.user_id = (SELECT id FROM current_user) AND d.document = i.document
         LEFT JOIN latest_progress p ON p.document = i.document AND p.rank = 1
         ORDER BY i.updated_at DESC, i.document`
      )
      .all(user.id) as unknown as {
      document: string;
      title: string | null;
      author: string | null;
      filename: string | null;
      percentage: number | null;
      progress_updated_at: number | null;
      updated_at: number;
    }[];

    const matches = (
      db
        .prepare(
          `SELECT connector_id, document, external_id, source, confidence, updated_at
           FROM connector_matches WHERE user_id = ?`
        )
        .all(user.id) as unknown as {
        connector_id: string;
        document: string;
        external_id: string | null;
        source: string;
        confidence: number;
        updated_at: number;
      }[]
    ).filter((match) => linkedIds.has(match.connector_id));

    const queueRows = (
      db
        .prepare(
          `SELECT connector_id, document, status, updated_at, last_error
           FROM connector_queue WHERE user_id = ?`
        )
        .all(user.id) as unknown as {
        connector_id: string;
        document: string;
        status: string;
        updated_at: number;
        last_error: string | null;
      }[]
    ).filter((row) => linkedIds.has(row.connector_id));

    const matchByKey = new Map(matches.map((match) => [`${match.connector_id}\0${match.document}`, match]));
    const queueByKey = new Map<string, QueueSummary>();
    for (const row of queueRows) {
      const key = `${row.connector_id}\0${row.document}`;
      const summary = queueByKey.get(key) ?? {
        pending: 0,
        done: 0,
        dead: 0,
        last_synced_at: null,
        last_error: null,
      };
      if (row.status === 'pending') summary.pending++;
      if (row.status === 'done') {
        summary.done++;
        summary.last_synced_at = Math.max(summary.last_synced_at ?? 0, row.updated_at);
      }
      if (row.status === 'dead') {
        summary.dead++;
        if (row.last_error) summary.last_error = row.last_error;
      }
      queueByKey.set(key, summary);
    }

    function stateFor(
      match: (typeof matches)[number] | undefined,
      queue: QueueSummary
    ): ServiceState {
      if (queue.dead) return 'error';
      if (queue.pending) return 'queued';
      if (queue.done) return 'synced';
      if (match?.external_id) return 'matched';
      if (match?.source === 'manual') return 'ignored';
      return 'needs_match';
    }

    const services = accounts.map((account) => ({
      id: account.connector_id,
      name: getConnector(account.connector_id)?.displayName ?? account.connector_id,
      status: account.status,
      account: account.account_label,
      last_error: account.last_error,
    }));

    return c.json({
      services,
      items: documents.map((document) => ({
        ...document,
        services: Object.fromEntries(
          accounts.map((account) => {
            const key = `${account.connector_id}\0${document.document}`;
            const match = matchByKey.get(key);
            const queue = queueByKey.get(key) ?? {
              pending: 0,
              done: 0,
              dead: 0,
              last_synced_at: null,
              last_error: null,
            };
            return [
              account.connector_id,
              {
                state: stateFor(match, queue),
                external_id: match?.external_id ?? null,
                source: match?.source ?? 'none',
                confidence: match?.confidence ?? 0,
                match_updated_at: match?.updated_at ?? null,
                ...queue,
              },
            ];
          })
        ),
      })),
    });
  });

  return app;
}
