ALTER TABLE events ADD COLUMN event_delegator bytea NULL;

CREATE INDEX events_event_delegator_index ON events (event_delegator);
