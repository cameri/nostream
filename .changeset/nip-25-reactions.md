---
"nostream": minor
---

Add NIP-25 Reactions support for kind 7 and kind 17 events: reaction utility helpers (`isReactionEvent`, `isExternalContentReactionEvent`, `isLikeReaction`, `isDislikeReaction`, `parseReaction`), schema validation enforcing required `e` tag on kind 7 and required `k`/`i` tags on kind 17, unit tests, and integration tests.