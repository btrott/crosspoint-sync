-- Position samples: a per-document history of (percentage -> real position
-- string) pairs, harvested from real device pushes. Lets us translate a
-- percentage-only update (e.g. Audiobookshelf fan-in) into a REAL KOReader
-- position (xpointer / page number) by nearest-percentage lookup, so stock
-- KOReader can actually seek to it instead of jumping to the start.
--
-- Bucketed by 0.1% (pct_bucket = round(percentage * 1000)) so the table stays
-- bounded (<=1001 rows/document) - each bucket keeps the latest seen position.
CREATE TABLE progress_samples (
  user_id     INTEGER NOT NULL,
  document    TEXT NOT NULL,
  pct_bucket  INTEGER NOT NULL,      -- round(percentage * 1000), 0..1000
  percentage  REAL NOT NULL,
  progress    TEXT NOT NULL,         -- real KOReader position (xpointer or page)
  position    TEXT,                  -- optional rich CompactPosition JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, document, pct_bucket)
);
CREATE INDEX idx_progress_samples_doc ON progress_samples(user_id, document, percentage);
