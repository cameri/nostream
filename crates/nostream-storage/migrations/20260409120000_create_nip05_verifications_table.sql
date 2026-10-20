CREATE TABLE nip05_verifications (
    pubkey bytea NOT NULL PRIMARY KEY,
    nip05 text NOT NULL,
    domain text NOT NULL,
    is_verified boolean NOT NULL DEFAULT false,
    last_verified_at timestamptz,
    last_checked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    failure_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_nip05_verifications_domain ON nip05_verifications (domain);
CREATE INDEX idx_nip05_verifications_is_verified ON nip05_verifications (is_verified);
CREATE INDEX idx_nip05_verifications_last_checked_at ON nip05_verifications (last_checked_at);
