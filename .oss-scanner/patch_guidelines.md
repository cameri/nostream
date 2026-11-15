# Patch guidelines — nostream

- A patch targets the Rust workspace under `crates/`, against the
  `rewrite/main` branch. Do not patch `src/`, `test/` or `website/`; they are the
  previous TypeScript implementation.
- Prefer the smallest change that closes the defect. Do not restructure, rename,
  or reformat code the fix does not touch, and do not add a dependency.
- Add a test that fails before the patch and passes after it, in the crate that
  owns the changed code (`crates/<crate>/tests/` for an integration test). State
  in the report which test proves the fix.
- Return `Result<_, StorageError>` (storage) or the crate's own error type rather
  than unwrapping; a client-reachable path must never `panic!`, `unwrap()` or
  index without a bounds check.
- The change must pass `cargo fmt --all --check`, and
  `cargo clippy --workspace --all-targets --all-features -- -D warnings`, and
  `cargo test --workspace --all-features`.
- Follow the existing comment style: explain why a rule exists, and keep measured
  facts with the code they constrain. No changelog entry is needed in the patch.
