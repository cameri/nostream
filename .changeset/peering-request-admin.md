---
"nostream": minor
---

feat(admin): account for peer on-demand requests

Records on-demand `REQ`, `COUNT`, and `NEG-OPEN` requests and the events served
for each authenticated peer pubkey in Redis. The admin console's Peering table
shows the request and event-served counts per peer, and the diagnostics export
includes the same counters. Accounting is best-effort and never fails the
request it describes.
