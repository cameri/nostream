ALTER TABLE users ADD COLUMN is_vanished boolean NOT NULL DEFAULT false;

UPDATE users u
SET is_vanished = true
WHERE EXISTS (
  SELECT 1 FROM events e
  WHERE e.event_pubkey = u.pubkey
    AND e.event_kind = 62
    AND e.deleted_at IS NULL
);
