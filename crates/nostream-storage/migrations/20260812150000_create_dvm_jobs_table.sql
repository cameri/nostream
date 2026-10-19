CREATE TABLE dvm_jobs (
    id bytea PRIMARY KEY,
    requester_pubkey bytea NOT NULL,
    kind integer NOT NULL,
    worker_index integer,
    status text NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'picked_up', 'completed', 'failed', 'timed_out')),
    result_event_id bytea,
    error text,
    picked_up_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_dvm_jobs_requester_pubkey ON dvm_jobs (requester_pubkey);
CREATE INDEX idx_dvm_jobs_status_created_at ON dvm_jobs (status, created_at);
CREATE INDEX idx_dvm_jobs_kind ON dvm_jobs (kind);
