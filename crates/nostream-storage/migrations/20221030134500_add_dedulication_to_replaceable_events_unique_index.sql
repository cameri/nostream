DROP INDEX IF EXISTS replaceable_events_idx;

CREATE UNIQUE INDEX replaceable_events_idx
ON events ( event_pubkey, event_kind, event_deduplication )
WHERE
  (
    event_kind = 0
    OR event_kind = 3
    OR (event_kind >= 10000 AND event_kind < 20000)
  )
  OR (event_kind >= 30000 AND event_kind < 40000);
