UPDATE events
SET event_deduplication = jsonb_build_array(right(event_pubkey::text, 64), event_kind)
WHERE event_kind IN (0, 3)
   OR event_kind BETWEEN 10000 AND 19999
  AND event_deduplication IS NULL;
