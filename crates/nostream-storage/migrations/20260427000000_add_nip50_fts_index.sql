-- no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_content_fts_idx ON events USING gin (to_tsvector('simple', event_content));
