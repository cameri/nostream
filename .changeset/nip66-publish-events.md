---
"nostream": minor
---

feat(nip66): publish kind 30166 and 10166 relay health events after probe runs

After each relay monitor probe run, sign and store NIP-66 relay discovery and monitor
announcement events using the configured monitor identity, bootstrap kind 0/10002 on
first run, and persist via the existing parameterized replaceable event path.

Fixes #696
