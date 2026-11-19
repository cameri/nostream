---
---

fix(migrate): open the migration target through a held descriptor rather than its path (#1162)

The target directory is pinned before the store opens and named through its descriptor as
`/proc/self/fd/<n>`, so the store's open, every manifest write and the summary all resolve to the
inode the security checks judged, however the operator's path is renamed afterwards. That narrows
the TOCTOU window between the check and the store's open; it does not close it, because heed
canonicalises the spelling before `mdb_env_open` (`heed-0.20.5/src/env.rs:239,305`), so the
mapping still resolves an absolute name.
