---
"nostream": minor
---

feat: wire the WoT graph into adaptive PoW difficulty

Adds `limits.event.pow.wotThresholds`, letting operators reduce (or bypass) the eventId PoW
requirement for pubkeys within their configured WoT distance. A direct follow can post instantly
under load while an unknown pubkey pays the full adaptive difficulty. Disabled by default (no
thresholds configured); requires `wot.enabled` to have any effect, since a pubkey's distance is
otherwise always unknown.
