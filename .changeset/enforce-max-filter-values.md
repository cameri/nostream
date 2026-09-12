---
"nostream": patch
---

fix: enforce `limits.client.subscription.maxFilterValues` on REQ and COUNT filters

Filters whose array criteria (`ids`, `authors`, `kinds`, `#<tag>`) hold more than
`maxFilterValues` values in total are now rejected with `Too many filter values`
instead of being handed to PostgreSQL as an unbounded `WHERE IN (...)`. The
limit was previously defined in settings and surfaced in the admin settings
editor while being read by nothing at all.

The enforced limit is also advertised in the NIP-11 `limitation` object as
`max_filter_values`, a non-standard extension since NIP-11 has no field for
per-filter value counts.
