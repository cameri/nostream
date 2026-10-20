---
---

fix(tooling): key the Rust build directory to the checkout

`scripts/rust.sh` mounted one `cache/target` at `/target` for every source tree. Every
checkout is mounted at the same container path, `/work/nostream`, so cargo could not tell
one tree's artifacts from another's: a scratch build left a test binary compiled from
reverted sources, the next run in a worktree executed it without recompiling, and only
touching the sources cleared it. The target directory is now derived from the checkout's
basename and a checksum of its full path (`/target-<name>-<checksum>`), and
`CARGO_TARGET_DIR` still overrides it. The toolchain and registry under the cache root stay
shared; the price is one cold build per checkout.
