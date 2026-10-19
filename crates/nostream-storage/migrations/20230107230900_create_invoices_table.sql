CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    pubkey bytea NOT NULL,
    bolt11 text NOT NULL,
    amount_requested bigint NOT NULL,
    amount_paid bigint,
    unit text CHECK (unit IN ('msats', 'sats', 'btc')),
    status text CHECK (status IN ('pending', 'completed', 'expired')),
    description text,
    confirmed_at timestamp(3),
    expires_at timestamp(3),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX invoices_pubkey_index ON invoices (pubkey);
