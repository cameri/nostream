CREATE TABLE users (
    pubkey bytea PRIMARY KEY,
    is_admitted boolean DEFAULT false,
    balance bigint DEFAULT 0,
    tos_accepted_at timestamp(3),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
