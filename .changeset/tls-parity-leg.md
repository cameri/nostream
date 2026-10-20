---
---

test(storage): replay the capture over TLS in the parity oracle

`scripts/storage-parity.sh` now starts a second Postgres with `ssl=on` and a self-signed
pair generated per run, and asserts the same 118-op replay over `sslmode=require` matches
both the TypeScript capture and the plaintext run. `pg_stat_ssl` confirms the session the
server sees, so a silently plaintext connection cannot pass, and the step fails if the
test is skipped rather than run. With `tls-none` restored the leg fails to connect instead
of falling back.
