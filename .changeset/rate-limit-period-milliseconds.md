---
"nostream": patch
---

fix(settings): state that rate-limit periods are milliseconds and reject a period that is not one

Every shipped limit counts in milliseconds — `1000`, `60000`, `900000`, `3600000` — but nothing said so. `RateLimit.period` is a bare `number`, so an operator writing `period: 60` for a minute got a 60 ms window: a limit a thousand times tighter than intended, honoured without complaint, and nothing in review caught it.

The unit is now stated on `RateLimit` and on every `rateLimits` block in `resources/default-settings.yaml`, and `validateRateLimitPeriods` rejects what cannot be a count of milliseconds: a fraction, a string, a non-number, or anything below one millisecond. A whole number is not enough to tell 60 from 60000, which is why the unit is documented where it is set.
