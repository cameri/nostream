---
"nostream": patch
---

fix(admin): Greptile follow-ups for moderation limits and activity stats

Moderation limit PATCH and ban/unban actions could interleave read–update–save across workers and drop updates. Those paths now run under an async settings write lock that yields while waiting and reclaims stale locks without deleting a fresh holder’s file. Activity stats windows filter on `first_seen` (when the relay first saw the event), not `event_created_at`, with partial indexes on live rows for those queries. IPv6 addresses on the rate-limit bypass list are normalized the same way as connection IPs so bypass rules cannot be skipped by formatting, including when removing entries stored in another spelling. PATCH rejects kind ranges with `start` greater than `end`. PATCH and moderation actions return the normalized limits read back from settings after save.
