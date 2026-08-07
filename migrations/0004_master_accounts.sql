-- Master ("general login") accounts. The website identity you sign into, kept
-- separate from the kosync sync credential your reader uses. A kosync account
-- (users row) is linked to a master account as its native sync identity; the
-- reading data and connectors stay keyed to the kosync user. See docs/design.

CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,          -- PBKDF2(MD5(master token))
  created_at INTEGER NOT NULL
);

-- Link a kosync user to its owning master account. NULL = orphan kosync account
-- (e.g. created directly on a device), linkable later. One kosync per master.
ALTER TABLE users ADD COLUMN account_id INTEGER REFERENCES accounts(id);
CREATE UNIQUE INDEX idx_users_account ON users(account_id) WHERE account_id IS NOT NULL;
