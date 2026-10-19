CREATE TABLE notification_outbox (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
    attempt_count integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error text,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notification_outbox_dispatch ON notification_outbox (status, available_at, created_at);
CREATE INDEX idx_notification_outbox_event_type_created_at ON notification_outbox (event_type, created_at);
