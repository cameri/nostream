---
---

fix(import): apply an imported deletion's `a` tags, as the live relay does (#1097)

The event import applied only a kind-5's `e` ids, so a request naming an article by address was stored while the article stayed readable. The importer now reads the request through the live delete arm's `deletion_targets`: `e` ids and the author's own addresses, deduplicated, and a request over either per-request cap is neither applied nor stored, counted as skipped. Rust-only, so this changeset is empty on purpose: no published package changes.
