---
"nostream": patch
---

fix: include the actual error message in replaceable event rejection responses

`ReplaceableEventStrategy.execute()` sent clients a bare `error: ` command result
(with no message body) whenever `eventRepository.upsert()` failed for a reason other
than a duplicate event id. The underlying `error.message` was caught but never
included in the response, leaving clients with no actionable information about why
the event was rejected. The command result now includes `error.message`.
