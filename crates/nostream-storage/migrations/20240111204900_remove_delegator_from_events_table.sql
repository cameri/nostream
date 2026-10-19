DROP INDEX IF EXISTS pubkey_delegator_kind_idx;

ALTER TABLE events DROP COLUMN event_delegator;
