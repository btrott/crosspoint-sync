-- Master-sync-hub connector framework. One row set per external service
-- (Hardcover, Readwise, ...), keyed by connector_id. See docs/design/sync-hub.md.

CREATE TABLE connector_accounts (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  connector_id  TEXT NOT NULL,          -- 'hardcover' | 'readwise' | ...
  cred_enc      TEXT NOT NULL,          -- AES-256-GCM encrypted credential JSON
  account_label TEXT,                   -- display name/email from the service, if known
  status        TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'needs_reauth' | 'error'
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, connector_id)
);

CREATE TABLE connector_matches (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  connector_id  TEXT NOT NULL,
  document      TEXT NOT NULL,
  external_id   TEXT,                   -- service book id (NULL = unmatched)
  external_edition TEXT,                -- optional edition id
  confidence    REAL NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'none',  -- 'auto' | 'manual' | 'none'
  query_used    TEXT,                   -- what we searched, for the review UI
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, connector_id, document)
);
CREATE INDEX idx_conn_matches_doc ON connector_matches(user_id, document);

CREATE TABLE connector_queue (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  connector_id  TEXT NOT NULL,
  document      TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- 'progress' | 'finished' | 'highlight'
  payload       TEXT NOT NULL,          -- JSON event body
  attempts      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'dead'
  next_try_at   INTEGER NOT NULL,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- Coalesce: a newer event of the same kind for the same book replaces the pending one.
  UNIQUE (user_id, connector_id, document, kind)
);
CREATE INDEX idx_conn_queue_ready ON connector_queue(status, next_try_at);
