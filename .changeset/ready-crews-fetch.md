---
"nostream": minor
---

Rewrite WoT service to use PostgreSQL for trust graph — eliminates unbounded in-memory accumulation by streaming kind-3 events into the DB and computing trust via SQL GROUP BY
