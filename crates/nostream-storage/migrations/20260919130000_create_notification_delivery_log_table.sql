CREATE TABLE notification_delivery_log (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    outbox_id uuid,
    event_type text NOT NULL,
    target_id text NOT NULL,
    target_type text NOT NULL CHECK (target_type IN ('http', 'discord', 'slack', 'telegram')),
    status text NOT NULL CHECK (status IN ('success', 'failed')),
    attempt_number integer NOT NULL,
    error_snippet text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notification_delivery_log_created_at ON notification_delivery_log (created_at);
CREATE INDEX idx_notification_delivery_log_event_created_at ON notification_delivery_log (event_type, created_at);

ALTER TABLE notification_delivery_log
ADD CONSTRAINT notification_delivery_log_outbox_id_foreign
FOREIGN KEY (outbox_id) REFERENCES notification_outbox(id) ON DELETE SET NULL;
