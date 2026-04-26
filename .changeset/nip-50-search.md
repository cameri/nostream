---
"nostream": major
---

Add NIP-50 full-text search support with PostgreSQL `tsvector`/`GIN` indexing.

Clients can now include a `search` field in REQ filter objects to perform full-text
queries against event content. Results are ranked by relevance (`ts_rank`) instead
of the usual `created_at` ordering, per the NIP-50 specification.

Features:
- New `search` filter field accepted in REQ messages
- PostgreSQL GIN index on `to_tsvector('simple', event_content)` for fast full-text lookups
- Configurable text-search language (defaults to `simple`, supports `english`, `spanish`, etc.)
- Configurable max search query length for abuse prevention
- NIP-50 listed in NIP-11 relay information document
- Search can be combined with all existing filter fields (kinds, authors, tags, etc.)
