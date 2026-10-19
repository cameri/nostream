CREATE INDEX event_tags_idx ON events USING GIN ( event_tags );
