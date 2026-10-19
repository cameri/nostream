CREATE TABLE invite_codes (
    code varchar(64) PRIMARY KEY,
    created_by bytea,
    claimed_by bytea,
    expires_at timestamptz,
    remaining_uses integer DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE invite_codes ADD CONSTRAINT chk_remaining_uses_non_negative CHECK (remaining_uses >= 0);

CREATE INDEX idx_invite_codes_expires_at ON invite_codes(expires_at) WHERE expires_at IS NOT NULL;
