CREATE TABLE reports (
    id serial PRIMARY KEY,
    event_id bytea NOT NULL,
    reporter_pubkey bytea NOT NULL,
    reported_pubkey bytea,
    reported_event_id bytea,
    report_type text NOT NULL
        CHECK (report_type IN ('nudity', 'malware', 'profanity', 'illegal', 'spam', 'impersonation', 'other')),
    weight real NOT NULL,
    actionable boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reports_event_id ON reports (event_id);
CREATE INDEX idx_reports_reported_pubkey ON reports (reported_pubkey);
CREATE INDEX idx_reports_reported_event_id ON reports (reported_event_id);
CREATE INDEX idx_reports_reporter_pubkey ON reports (reporter_pubkey);
CREATE INDEX idx_reports_actionable_created_at ON reports (actionable, created_at);
