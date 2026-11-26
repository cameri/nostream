---
---

fix(maintenance): keep a timed-out purge and wait on it, instead of starting another (#1103)

A retention purge that outlived its 5 s cap was detached, not stopped: the pass returned, the loop cleared its running flag, and every later tick started another purge, so a store whose cleanup was slower than the interval accumulated purges competing for the same database. The worker now holds the timed-out purge. The next pass waits on it again (with the same cap) instead of starting a second one, and reports its counts if it finishes then; only once it has finished does a pass start a new purge. A purge that finishes between passes has its result logged rather than lost. The loop logs each pass's outcome. A purge that never returns now holds retention until it does or the relay restarts, rather than being joined by a new purge every tick; each pass that waits on it logs how many passes it has waited. Rust-only; no published package changes.
