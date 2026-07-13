import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { secretsEnabled } from '../../crypto/secrets.js';
import { fetchTransport, getConnector, listConnectors } from '../../connectors/registry.js';
import { purgeConnector, queueDepth } from '../../connectors/queue.js';
import { resolveMatch } from '../../connectors/runner.js';
import {
  deleteAccount,
  getAccount,
  getMatch,
  listMatches,
  saveMatch,
  upsertAccount,
} from '../../connectors/store.js';
import { isValidDocument } from '../kosync.js';
import type { HttpTransport } from '../../connectors/types.js';

/**
 * Master-sync-hub connector management. Same x-auth headers as the rest of v1.
 * Credential entry realistically happens from a browser (token paste / OAuth),
 * but every endpoint works over curl too.
 *
 * `transport` is injectable so tests can validate/link connectors without real
 * network calls.
 */
export function connectorRoutes(db: DB, transport: HttpTransport = fetchTransport): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // List available connectors + this user's link status.
  app.get('/connectors', (c) => {
    const user = c.get('user');
    const enabled = secretsEnabled();
    return c.json({
      encryption: enabled ? 'enabled' : 'disabled',
      connectors: listConnectors().map((conn) => {
        const account = getAccount(db, user.id, conn.id);
        return {
          id: conn.id,
          name: conn.displayName,
          tier: conn.tier,
          experimental: conn.experimental,
          carries: conn.carries,
          capabilities: conn.capabilities,
          credential_kind: conn.credentialKind,
          linked: !!account,
          status: account?.status ?? null,
          account: account?.account_label ?? null,
          queue: account ? queueDepth(db, user.id, conn.id) : undefined,
        };
      }),
    });
  });

  // Link (or re-link) a connector by validating and storing its credential.
  app.put('/connectors/:id', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!secretsEnabled()) {
      return c.json(
        { code: 2003, message: 'Server has no TOKEN_ENC_KEY; connector storage disabled' },
        403
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const cred = (body as Record<string, unknown> | null)?.credential;
    if (typeof cred !== 'object' || cred === null) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const result = await conn.validate(cred as Record<string, unknown>, transport);
    if (!result.ok) {
      return c.json({ code: 2003, message: result.error ?? 'Credential rejected' }, 400);
    }
    const user = c.get('user');
    upsertAccount(db, user.id, conn.id, cred as Record<string, unknown>, result.accountLabel ?? null);
    return c.json({ id: conn.id, linked: true, account: result.accountLabel ?? null });
  });

  // Unlink and wipe queued work + matches.
  app.delete('/connectors/:id', (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const user = c.get('user');
    withTransaction(db, () => {
      deleteAccount(db, user.id, conn.id);
      purgeConnector(db, user.id, conn.id);
      db.prepare('DELETE FROM connector_matches WHERE user_id = ? AND connector_id = ?').run(
        user.id,
        conn.id
      );
    });
    return c.json({ id: conn.id, linked: false });
  });

  // List this user's book matches for a connector (for the review UI).
  app.get('/connectors/:id/matches', (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const user = c.get('user');
    return c.json({
      connector: conn.id,
      matches: listMatches(db, user.id, conn.id).map((m) => ({
        document: m.document,
        external_id: m.external_id,
        confidence: m.confidence,
        source: m.source,
        query_used: m.query_used,
        updated_at: m.updated_at,
      })),
    });
  });

  // Manually set/override a match (sticky — never auto-recomputed).
  app.put('/connectors/:id/matches/:document', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const externalId = o.external_id;
    const user = c.get('user');
    if (externalId === null) {
      // Explicit "no match" override — stop trying to sync this document.
      saveMatch(db, user.id, conn.id, document, null, 'manual');
      return c.json({ document, external_id: null, source: 'manual' });
    }
    if (typeof externalId !== 'string' || externalId.length === 0 || externalId.length > 128) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    saveMatch(
      db,
      user.id,
      conn.id,
      document,
      {
        externalId,
        externalEdition: typeof o.external_edition === 'string' ? o.external_edition : null,
        confidence: 1,
      },
      'manual'
    );
    return c.json({ document, external_id: externalId, source: 'manual' });
  });

  // Force (re)matching of a document now — useful for testing and the review UI.
  app.post('/connectors/:id/rematch/:document', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    if (!getAccount(db, user.id, conn.id)) {
      return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    }
    // Clear any auto/none row so resolveMatch recomputes (manual is preserved).
    const existing = getMatch(db, user.id, conn.id, document);
    if (existing && existing.source !== 'manual') {
      db.prepare(
        'DELETE FROM connector_matches WHERE user_id = ? AND connector_id = ? AND document = ?'
      ).run(user.id, conn.id, document);
    }
    const match = await resolveMatch(db, conn.id, user.id, document, transport);
    return c.json({ document, match: match ?? null });
  });

  return app;
}
