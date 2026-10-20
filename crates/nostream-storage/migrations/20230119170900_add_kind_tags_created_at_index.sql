CREATE EXTENSION btree_gin;

CREATE INDEX kind_tags_created_at_idx
ON events USING GIN ( event_kind, event_tags, event_created_at );
