---
"nostream": patch
---

Implement geohash wildcard/prefix behavior for `#g` filters (closes #265): a
criterion ending in `*` matches any event `g` tag whose value starts with the
prefix before `*`; exact matching (no `*`) is unchanged. Only normal geohash
prefixes are intended as input. This is a Nostream extension, not part of
NIP-12.
