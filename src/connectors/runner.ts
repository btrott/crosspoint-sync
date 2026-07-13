import type { DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { getConnector, fetchTransport } from './registry.js';
import {
  claimReady,
  markDone,
  markFailed,
  type QueueRow,
} from './queue.js';
import {
  decryptCredential,
  documentMeta,
  getAccount,
  getMatch,
  saveMatch,
  setAccountStatus,
} from './store.js';
import type { HttpTransport, Match, OutboundEvent } from './types.js';

/**
 * Resolve a connector match for a document, using the cached row when present.
 * Manual matches are authoritative and never recomputed. Missing/auto rows are
 * (re)computed via the connector's own search. Returns null when unmatched.
 */
export async function resolveMatch(
  db: DB,
  connectorId: string,
  userId: number,
  document: string,
  http: HttpTransport
): Promise<Match | null> {
  const cached = getMatch(db, userId, connectorId, document);
  if (cached && cached.source === 'manual') {
    return cached.external_id
      ? {
          externalId: cached.external_id,
          externalEdition: cached.external_edition,
          confidence: cached.confidence,
        }
      : null;
  }
  if (cached && cached.external_id) {
    return {
      externalId: cached.external_id,
      externalEdition: cached.external_edition,
      confidence: cached.confidence,
    };
  }

  const connector = getConnector(connectorId);
  const account = getAccount(db, userId, connectorId);
  if (!connector || !account) return null;
  const cred = decryptCredential(account);
  const meta = documentMeta(db, userId, document);
  const match = await connector.match(cred, meta, http);
  saveMatch(db, userId, connectorId, document, match, match ? 'auto' : 'none');
  return match;
}

/** Process a single queued event. Returns true if handled (done or dead). */
export async function processRow(db: DB, row: QueueRow, http: HttpTransport): Promise<void> {
  const connector = getConnector(row.connector_id);
  const account = getAccount(db, row.user_id, row.connector_id);
  if (!connector || !account || !account.enabled) {
    // Connector gone or disabled — drop permanently.
    markFailed(db, row, 'connector unavailable or disabled', false);
    return;
  }
  if (account.status === 'needs_reauth') {
    markFailed(db, row, 'account needs reauth', false);
    return;
  }

  let match: Match | null;
  try {
    match = await resolveMatch(db, row.connector_id, row.user_id, row.document, http);
  } catch (err) {
    markFailed(db, row, `match failed: ${errStr(err)}`, true);
    return;
  }
  if (!match) {
    // Unmatched documents can't be pushed; drop this event (a later manual
    // match + fresh sync will re-enqueue). Not an error state.
    markFailed(db, row, 'no book match', false);
    return;
  }

  const ev = JSON.parse(row.payload) as OutboundEvent;
  const cred = decryptCredential(account);
  try {
    const result = await connector.push(cred, match, ev, http);
    if (result.ok) {
      markDone(db, row.id);
      return;
    }
    if (result.needsReauth) {
      setAccountStatus(db, row.user_id, row.connector_id, 'needs_reauth', result.error);
    }
    markFailed(db, row, result.error, result.retryable);
  } catch (err) {
    markFailed(db, row, errStr(err), true);
  }
}

/** Drain up to `limit` ready events. Returns the number processed. */
export async function drainQueue(
  db: DB,
  http: HttpTransport = fetchTransport,
  limit = 20,
  now = nowSeconds()
): Promise<number> {
  const rows = claimReady(db, limit, now);
  for (const row of rows) {
    await processRow(db, row, http);
  }
  return rows.length;
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Start a periodic drain loop; returns a stop function. */
export function startQueueWorker(db: DB, intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap drains
    running = true;
    try {
      await drainQueue(db);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'queue drain error', error: errStr(err) }));
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
