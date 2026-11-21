---
---

chore(test): stop writing debug info into test binaries

Nothing in this repository reads it: `cargo test`, `clippy`, `fmt`, CI and the review lenses either never open a symbol table or print a panic location, which the compiler emits regardless. It was 81% of a 236 MB test binary. Measured from a cold target dir on `-p nostream-mcp --test auth`: binary 230 MB → 43 MB, build 75 s → 49 s, target dir 1.6 GB → 0.8 GB. `dev` keeps the default, because `cargo build` output is the one artifact a person opens in a debugger. Rust-only, so this changeset is empty on purpose: no published package changes.
