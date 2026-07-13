CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  key_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE documents (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  document   TEXT NOT NULL,
  title      TEXT,
  author     TEXT,
  filesize   INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, document)
);

CREATE TABLE progress (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  document   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  device     TEXT NOT NULL DEFAULT '',
  percentage REAL NOT NULL,
  progress   TEXT NOT NULL,
  position   TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, document, device_id)
);
CREATE INDEX idx_progress_latest ON progress(user_id, document, updated_at DESC);

CREATE TABLE bookmarks (
  user_id         INTEGER NOT NULL REFERENCES users(id),
  document        TEXT NOT NULL,
  id              TEXT NOT NULL,
  xpath           TEXT NOT NULL DEFAULT '',
  percentage      REAL NOT NULL DEFAULT 0,
  summary         TEXT NOT NULL DEFAULT '',
  spine_index     INTEGER,
  paragraph_count INTEGER,
  paragraph_pos   INTEGER,
  deleted         INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, document, id)
);
CREATE INDEX idx_bookmarks_since ON bookmarks(user_id, document, updated_at, id);

CREATE TABLE clippings (
  user_id         INTEGER NOT NULL REFERENCES users(id),
  document        TEXT NOT NULL,
  id              TEXT NOT NULL,
  spine_index     INTEGER NOT NULL DEFAULT 0,
  start_page      INTEGER NOT NULL DEFAULT 0,
  end_page        INTEGER NOT NULL DEFAULT 0,
  page_count      INTEGER NOT NULL DEFAULT 1,
  start_word      INTEGER NOT NULL DEFAULT 0,
  end_word        INTEGER NOT NULL DEFAULT 0,
  word_count      INTEGER NOT NULL DEFAULT 0,
  paragraph_index INTEGER,
  chapter_title   TEXT NOT NULL DEFAULT '',
  text            TEXT NOT NULL DEFAULT '',
  note            TEXT,
  color           TEXT,
  created_at      INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, document, id)
);
CREATE INDEX idx_clippings_since ON clippings(user_id, document, updated_at, id);

CREATE TABLE stats_device_global (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  device_id  TEXT NOT NULL,
  device     TEXT NOT NULL DEFAULT '',
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE stats_device_book (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  device_id  TEXT NOT NULL,
  document   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, document)
);
CREATE INDEX idx_stats_book_doc ON stats_device_book(user_id, document);
