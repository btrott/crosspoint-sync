import type { DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import type { Credential, DocumentMeta, Match } from './types.js';

export interface AccountRow {
  user_id: number;
  connector_id: string;
  cred_enc: string;
  account_label: string | null;
  status: string;
  enabled: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function upsertAccount(
  db: DB,
  userId: number,
  connectorId: string,
  cred: Credential,
  accountLabel: string | null,
  now = nowSeconds()
): void {
  const enc = encryptSecret(JSON.stringify(cred));
  db.prepare(
    `INSERT INTO connector_accounts
       (user_id, connector_id, cred_enc, account_label, status, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ok', 1, ?, ?)
     ON CONFLICT(user_id, connector_id) DO UPDATE SET
       cred_enc = excluded.cred_enc,
       account_label = excluded.account_label,
       status = 'ok',
       enabled = 1,
       last_error = NULL,
       updated_at = excluded.updated_at`
  ).run(userId, connectorId, enc, accountLabel, now, now);
}

export function getAccount(db: DB, userId: number, connectorId: string): AccountRow | null {
  return (
    (db
      .prepare('SELECT * FROM connector_accounts WHERE user_id = ? AND connector_id = ?')
      .get(userId, connectorId) as AccountRow | undefined) ?? null
  );
}

export function listAccounts(db: DB, userId: number): AccountRow[] {
  return db
    .prepare('SELECT * FROM connector_accounts WHERE user_id = ?')
    .all(userId) as unknown as AccountRow[];
}

export function decryptCredential(row: AccountRow): Credential {
  return JSON.parse(decryptSecret(row.cred_enc)) as Credential;
}

export function deleteAccount(db: DB, userId: number, connectorId: string): void {
  db.prepare('DELETE FROM connector_accounts WHERE user_id = ? AND connector_id = ?').run(
    userId,
    connectorId
  );
}

export function setAccountStatus(
  db: DB,
  userId: number,
  connectorId: string,
  status: string,
  error: string | null,
  now = nowSeconds()
): void {
  db.prepare(
    'UPDATE connector_accounts SET status = ?, last_error = ?, updated_at = ? WHERE user_id = ? AND connector_id = ?'
  ).run(status, error, now, userId, connectorId);
}

/** All connector accounts that are linked, enabled, and healthy for fan-out. */
export function activeConnectorIds(db: DB, userId: number): string[] {
  return (
    db
      .prepare(
        `SELECT connector_id FROM connector_accounts WHERE user_id = ? AND enabled = 1 AND status != 'error'`
      )
      .all(userId) as { connector_id: string }[]
  ).map((r) => r.connector_id);
}

export interface MatchRow {
  user_id: number;
  connector_id: string;
  document: string;
  external_id: string | null;
  external_edition: string | null;
  confidence: number;
  source: string;
  query_used: string | null;
  updated_at: number;
}

export function getMatch(
  db: DB,
  userId: number,
  connectorId: string,
  document: string
): MatchRow | null {
  return (
    (db
      .prepare(
        'SELECT * FROM connector_matches WHERE user_id = ? AND connector_id = ? AND document = ?'
      )
      .get(userId, connectorId, document) as MatchRow | undefined) ?? null
  );
}

export function saveMatch(
  db: DB,
  userId: number,
  connectorId: string,
  document: string,
  match: Match | null,
  source: 'auto' | 'manual' | 'none',
  now = nowSeconds()
): void {
  db.prepare(
    `INSERT INTO connector_matches
       (user_id, connector_id, document, external_id, external_edition, confidence, source, query_used, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, connector_id, document) DO UPDATE SET
       external_id = excluded.external_id,
       external_edition = excluded.external_edition,
       confidence = excluded.confidence,
       source = excluded.source,
       query_used = excluded.query_used,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    connectorId,
    document,
    match?.externalId ?? null,
    match?.externalEdition ?? null,
    match?.confidence ?? 0,
    source,
    match?.queryUsed ?? null,
    now
  );
}

export function listMatches(db: DB, userId: number, connectorId: string): MatchRow[] {
  return db
    .prepare(
      'SELECT * FROM connector_matches WHERE user_id = ? AND connector_id = ? ORDER BY updated_at DESC'
    )
    .all(userId, connectorId) as unknown as MatchRow[];
}

export function documentMeta(db: DB, userId: number, document: string): DocumentMeta {
  const row = db
    .prepare('SELECT title, author, filename FROM documents WHERE user_id = ? AND document = ?')
    .get(userId, document) as
    | { title: string | null; author: string | null; filename: string | null }
    | undefined;
  return {
    document,
    title: row?.title ?? null,
    author: row?.author ?? null,
    filename: row?.filename ?? null,
  };
}
