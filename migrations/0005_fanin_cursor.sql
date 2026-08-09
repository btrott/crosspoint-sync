-- Fan-in polling cursor per connector account: the high-water mark (ms epoch)
-- of the last change we pulled, so we only process new updates. See docs/design
-- (bidirectional sync).
ALTER TABLE connector_accounts ADD COLUMN pull_cursor INTEGER NOT NULL DEFAULT 0;
