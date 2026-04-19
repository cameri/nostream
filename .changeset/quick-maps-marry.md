---
"nostream": minor
---

Add gzip and xz compression support to event import/export flows.

- Export supports `--compress`/`-z` with `--format gzip|gz|xz`.
- Import auto-detects compressed input by extension and magic bytes and decompresses in a stream pipeline.
- Includes docs updates and unit/integration test coverage for compression paths.