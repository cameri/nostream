CREATE UNIQUE INDEX pubkey_delegator_kind_idx ON events ( event_pubkey, event_delegator, event_kind );
