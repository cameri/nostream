---
---

feat(import): prove the element scanner with Kani

`crates/nostream-scan` extracts the JSON array-element scanner from `nostream-services` with no
dependencies, so a bounded model checker can reason about it without compiling the relay's
dependency graph. Five harnesses under `cfg(kani)` prove panic-freedom over every four-byte input,
the probe schedule that bounds a malformed element's buffering, the resume step that keeps the
reader from spinning on one delimiter, and that a second scan consumes nothing new. The last one is
the regression that let a scalar of `x` bytes buffer 4 MiB before the parser saw it; with the
pre-fix state machine the proof fails, which is how the harness is known to be able to fail.

Rust only: no published package changes, so this entry carries no version bump. The operator-facing
carriers are `cargo kani -p nostream-scan`, the `kani-proofs` CI job, and the proofs themselves.
