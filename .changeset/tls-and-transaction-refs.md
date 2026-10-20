---
---

fix(storage): negotiate TLS, and keep an enqueued id addressable inside its transaction

`sqlx` was selected with `tls-none`, so a database that requires `sslmode=require`
could not be reached at all (#911). The workspace dependency now enables
`tls-rustls-ring-webpki` — ring with webpki roots, no native-tls — and the TLS
path now has a committed regression test: the parity target requires a
`sslmode=require` connection to be attempted rather than refused by the build,
and completes `SELECT 1` when the server offers TLS.

The parity harness's `run_transaction` handed every nested op a fresh refs map,
so an `outbox.enqueue` followed by `outbox.mark_delivered` in one group lost the
id and came back as a failed transaction (#912). The caller's map is threaded
through the nested calls, the capture generator does the same, and a new
transaction group in the fixture enqueues and then marks the row delivered, so
the TypeScript capture and the Rust replay agree on the id.
