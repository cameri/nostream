---
"nostream": patch
---

fix: de-duplicate events returned by generic tag-filter subscriptions

`EventRepository.findByFilters()` left-joins `event_tags` for generic tag filters
(`#e`, `#p`, etc.) without deduplicating the result. An event matching more than one
tag row for the same filter (e.g. `{"#p": ["a", "b"]}` matching an event tagged with
both) was returned once per matching `event_tags` row, so subscribers received the
same `EVENT` message multiple times. The query now selects `DISTINCT events.*` for
tag-filtered queries so each stored event is returned at most once.
