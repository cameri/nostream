-- The knex source runs this file outside a transaction because it builds both indexes with
-- CREATE INDEX CONCURRENTLY. The rewrite's migrator applies the whole schema to a fresh
-- database, where the lock mode has no effect, so the two statements run inside the
-- migration's transaction and produce identical index definitions.

CREATE INDEX IF NOT EXISTS reports_actionable_reported_event_id_idx
ON reports (reported_event_id)
WHERE actionable = true AND reported_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reports_actionable_reported_pubkey_idx
ON reports (reported_pubkey)
WHERE actionable = true AND reported_pubkey IS NOT NULL;
