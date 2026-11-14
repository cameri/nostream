---
"nostream": minor
---

feat(peering): renew, lapse and expose paid peering access

The billing worker now issues renewal invoices before a period ends, rechecks
pending payments before lapsing a peer, closes live peer sockets on lapse, and
keeps stored events and sync state for a later resume. `GET /admin/peering` and
the dashboard show billing status, access end, the open invoice and the last
processor error.
