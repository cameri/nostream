CREATE TABLE events (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id bytea NOT NULL UNIQUE,
    event_pubkey bytea NOT NULL,
    event_kind integer NOT NULL,
    event_created_at integer NOT NULL,
    event_content text NOT NULL,
    event_tags jsonb,
    event_signature bytea NOT NULL,
    first_seen timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX events_event_id_index ON events (event_id);
CREATE INDEX events_event_pubkey_index ON events (event_pubkey);
CREATE INDEX events_event_kind_index ON events (event_kind);
CREATE INDEX events_event_created_at_index ON events (event_created_at);
