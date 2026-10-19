-- no-transaction
-- The knex source runs this file outside a transaction because it builds its indexes with
-- CREATE INDEX CONCURRENTLY, which PostgreSQL refuses inside a transaction block. The
-- rewrite's migrator applies migrations to a fresh database, and a multi-statement simple
-- query is itself an implicit transaction block, so the three indexes are built without
-- CONCURRENTLY here; the resulting index definitions are identical (ADR 0003, "Migrations").
-- The file keeps `-- no-transaction` to mirror the knex file's non-transactional intent; each
-- statement autocommits.

CREATE INDEX IF NOT EXISTS events_active_pubkey_kind_created_at_idx
ON events (event_pubkey, event_kind, event_created_at DESC, event_id);

CREATE INDEX IF NOT EXISTS events_deleted_at_partial_idx
ON events (deleted_at)
WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_pending_created_at_idx
ON invoices (created_at)
WHERE status = 'pending';
