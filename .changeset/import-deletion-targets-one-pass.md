---
'nostream': patch
---

fix(import): collect the ids of a deletion request in one loop and cap them at 65,533

The importer collected the ids a kind-5 deletion request names by copying the list for every `e` tag, so a request with 50,000 tags held the import for seconds, and one with more than 65,533 valid `e` tags overflowed PostgreSQL's bind parameters and ended the whole import. The ids are now collected in one loop, and a repeated id is asked for once. A request whose `e` tags name more than 65,533 distinct event ids, the most one delete statement can carry, is refused: nothing is deleted or stored, it counts as an error, and the import goes on. No request a v3 relay could have applied is over this limit. Peering sync, which writes through the same code, gets the faster collection but no cap; its frames are already limited to 2 MiB.
