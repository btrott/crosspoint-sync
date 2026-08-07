import type { DB } from '../db/db.js';
import { secretsEnabled } from '../crypto/secrets.js';
import { getConnector } from './registry.js';
import { enqueue } from './queue.js';
import { activeConnectorIds } from './store.js';
import type { OutboundEvent } from './types.js';

/**
 * Enqueue canonical reading events to every linked connector that carries the
 * event's kind. Best-effort and synchronous-but-cheap (DB inserts only); the
 * queue worker does the network I/O. Never throws into the request path.
 */
function fanOut(db: DB, userId: number, ev: OutboundEvent, coalesceKey?: string): void {
  if (!secretsEnabled()) return;
  try {
    for (const connectorId of activeConnectorIds(db, userId)) {
      const conn = getConnector(connectorId);
      if (!conn || !conn.capabilities.write || !conn.carries.includes(ev.kind)) continue;
      enqueue(db, userId, connectorId, ev, coalesceKey);
    }
  } catch (err) {
    console.error(
      JSON.stringify({ msg: 'fanout enqueue failed', error: err instanceof Error ? err.message : String(err) })
    );
  }
}

export function fanOutProgress(
  db: DB,
  userId: number,
  document: string,
  percentage: number,
  timestamp: number,
  progress?: string,
  positionJson?: string | null
): void {
  const finished = percentage >= 0.98;
  let position: Record<string, unknown> | null = null;
  if (positionJson) {
    try {
      position = JSON.parse(positionJson) as Record<string, unknown>;
    } catch {
      position = null;
    }
  }
  fanOut(db, userId, {
    kind: finished ? 'finished' : 'progress',
    document,
    percentage,
    progress,
    position,
    timestamp,
  });
}

export function fanOutHighlight(
  db: DB,
  userId: number,
  document: string,
  clippingId: string,
  h: NonNullable<OutboundEvent['highlight']>,
  timestamp: number
): void {
  // Per-clipping coalesce key so distinct highlights on one book each queue.
  fanOut(db, userId, { kind: 'highlight', document, timestamp, highlight: h }, `highlight:${clippingId}`);
}
