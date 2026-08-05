---
"nostream": patch
---

test: optimize nip05.spec.ts & nip03.spec.ts resource management

- Lift sinon stub to `before`/`after` in verifyNip05Identifier tests (create once, reset between tests)
- Extract SSRF guard callback once in `before` instead of per-test `beforeEach`
- Pre-build shared OTS buffers and attestations at module scope to eliminate redundant Buffer.concat calls
- Add shared event factory for extractNip05FromEvent tests
