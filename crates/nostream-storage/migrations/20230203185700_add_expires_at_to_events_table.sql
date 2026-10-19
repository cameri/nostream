ALTER TABLE events ADD COLUMN expires_at integer NULL;

CREATE INDEX events_expires_at_index ON events (expires_at);
