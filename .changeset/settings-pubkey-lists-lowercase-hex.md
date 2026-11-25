---
'nostream': patch
---

fix(admin): refuse pubkeys in the settings lists that cannot match an event

The pubkey blacklist, the pubkey whitelist and the rate-limit bypass list (`limits.event.pubkey.blacklist`, `limits.event.pubkey.whitelist` and `limits.event.whitelists.pubkeys`) are compared with the pubkey of each event as they are written, and an event's pubkey is always 64 lowercase hex characters. The settings API saved any value in them, so a blacklist entry written in uppercase hex was stored and then never matched, and the pubkey it was meant to ban could still publish. Settings validation now rejects an entry that is not a 64-character lowercase hex pubkey, and says which entry, for the settings API, the CLI, backup restore and the validate endpoint. Pubkeys added through the moderation endpoints are already normalized and are not affected. A settings file that already holds an entry written another way is not rejected at startup, but the next settings change made through those paths is refused until the entry is fixed.
