import type { DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { getConnector, fetchTransport } from './registry.js';
import { fanOutProgress } from './fanout.js';
import { upsertProgress } from '../routes/kosync.js';
import {
  decryptCredential,
  documentForExternal,
  getAccount,
  getPullCursor,
  latestPercentage,
  listAllEnabledAccounts,
  setPullCursor,
} from './store.js';
import type { HttpTransport } from './types.js';

// Skip an inbound change whose percentage already matches our stored progress
// (within this window). This suppresses the echo of a value we just pushed OUT
// to the same service, so read->push->pull doesn't loop.
const ECHO_EPSILON = 0.005;

/**
 * Pull position changes from one connector and apply them to canonical progress.
 * Maps each change back to our document via the match table, writes it as a
 * per-connector "device" row so the reader picks it up (newest-wins kosync GET),
 * and re-fans-out to the OTHER services (not back to the source). Returns the
 * number of changes applied.
 */
export async function pollConnector(
  db: DB,
  userId: number,
  connectorId: string,
  http: HttpTransport = fetchTransport
): Promise<number> {
  const conn = getConnector(connectorId);
  const account = getAccount(db, userId, connectorId);
  if (!conn || !account || !account.enabled || !conn.pullChanges || !conn.capabilities.read) {
    return 0;
  }
  const since = getPullCursor(db, userId, connectorId);
  let changes;
  try {
    changes = await conn.pullChanges(decryptCredential(account), http, since);
  } catch {
    return 0; // best-effort; try again next tick
  }

  let applied = 0;
  let maxCursor = since;
  for (const ch of changes) {
    if (ch.updatedAtMs > maxCursor) maxCursor = ch.updatedAtMs;
    const document = documentForExternal(db, userId, connectorId, ch.externalId);
    if (!document) continue; // not a book we sync
    const pct = ch.finished || ch.percentage >= 0.999 ? 1 : ch.percentage;
    const current = latestPercentage(db, userId, document);
    if (current != null && Math.abs(current - pct) < ECHO_EPSILON) continue; // echo of our own push

    const now = nowSeconds();
    upsertProgress(db, {
      userId,
      document,
      deviceId: connectorId,
      device: conn.displayName,
      percentage: pct,
      // Synthetic progress string; the reader maps by percentage when the xpath
      // isn't its own. Prefixed so it's identifiable.
      progress: `${connectorId}:${Math.round(pct * 1_000_000)}`,
      position: null,
      metadata: null,
      updatedAt: now,
    });
    // Push this position to the OTHER services, but not back to the source.
    fanOutProgress(db, userId, document, pct, now, undefined, null, connectorId);
    applied++;
  }

  if (maxCursor > since) setPullCursor(db, userId, connectorId, maxCursor);
  return applied;
}

/** Poll every read-capable connector account once. Returns total applied. */
export async function pollAll(db: DB, http: HttpTransport = fetchTransport): Promise<number> {
  let total = 0;
  for (const { user_id, connector_id } of listAllEnabledAccounts(db)) {
    const conn = getConnector(connector_id);
    if (!conn?.pullChanges || !conn.capabilities.read) continue;
    total += await pollConnector(db, user_id, connector_id, http);
  }
  return total;
}

/** Start the periodic fan-in poller; returns a stop function. */
export function startFanInWorker(db: DB, intervalMs = 5 * 60_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollAll(db);
    } catch (err) {
      console.error(
        JSON.stringify({ msg: 'fan-in poll error', error: err instanceof Error ? err.message : String(err) })
      );
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
