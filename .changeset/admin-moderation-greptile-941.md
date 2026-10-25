---
"nostream": patch
---

fix(admin): Greptile follow-ups for moderation limits and activity stats

Moderation limit PATCH and ban/unban actions could interleave read–update–save across workers and drop updates. Those paths now run under a settings write lock. Activity stats windows filter on `first_seen` (when the relay first saw the event), not `event_created_at`. IPv6 addresses on the rate-limit bypass list are normalized the same way as connection IPs so bypass rules cannot be skipped by formatting. PATCH rejects kind ranges with `start` greater than `end`. PATCH and moderation actions return the normalized limits read back from settings after save.
