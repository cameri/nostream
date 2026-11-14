---
---

docs(storage): state the count cap's cost as a decode per key past it, not per repeated key (#1081)

ADR 0011 and the comments in `lmdb/events.rs` said the cap on a tag count's id set costs
"a body decode per repeated key past it". `counted_earlier` reads the row's body for every
key the set does not answer past the cap, unless the range is the family's first exact
criterion, so the cost is not confined to repeated keys: a `{"#t":["zz","a"]}` filter,
one key a row and no repeats, costs 5.7× its uncapped walk at 20,000 rows. The record
and its copies now say so, and qualify "below the cap the walk reads no body" to a walk
over a single tag family, since a second family decodes there too.

Comment and prose only: no code changes and no behaviour change.
