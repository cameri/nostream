# nostream — working on `rewrite/main`

The Rust rewrite replaces the TypeScript relay **in place, crate by crate, on this
branch**. `main` receives it only at cutover. Until then `src/` (TypeScript) and
`crates/` (Rust) coexist in one tree and are separate pipelines.

Rules below are the ones an agent gets wrong. Generic Rust guidance is not repeated
here.

## Version control

- **Work on `rewrite/main` (or a branch off it), never `main`.**
- A PR into `rewrite/main` must carry **one empty changeset**
  (`.changeset/<name>.md` with empty frontmatter) — `Changeset Required` runs on every
  PR and a Rust-only change touches no published package. The changeset *content* is
  changed only when the TypeScript package itself changes.
- Commits are commitlint-checked (`Lint commits`); conventional-commit form is required.
- **The husky `pre-commit` hook runs the TypeScript suite**
  (`pnpm run lint`, `build:check`, `test:unit`) on every commit. A Rust-only change
  cannot fail those, and CI runs the same three as `Lint code`, `Build check` and
  `Unit Tests And Coverage` against the same change — so `--no-verify` is reasonable for
  a Rust-only commit and never for one that touches `src/`, `test/` or a JS manifest.

## Validation — the exact commands

CI (`Rust Checks` in `.github/workflows/checks.yml`) is the authority. Run the same
five, in this order, and they must all pass before a change is claimed done:

```
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo clippy --workspace --lib --bins --all-features -- \
  -D warnings -D clippy::unwrap_used -D clippy::expect_used \
  -D clippy::todo -D clippy::unimplemented -D clippy::panic
cargo test --workspace --all-features
cargo build --workspace --all-features --release
```

- **`--workspace`, never a single crate.** A crate-local `cargo test -p` proves nothing
  about a workspace lint that another member trips.
- **`--all-features` is not optional.** `nostreamd`'s `otlp` feature gates three
  dependencies; a change that only compiles without it is broken.
- **Two clippy passes, and both are required.** The lints `unwrap_used`, `expect_used`
  and `panic` are declared in `[workspace.lints.clippy]` as well as passed on the strict
  command line, so a local `cargo clippy` fails on the same code CI rejects. An
  integration-test target that needs them carries
  `#![allow(clippy::unwrap_used, clippy::expect_used)]` (plus `clippy::panic` where it
  asserts by panicking) at the top of the file — naming the file that may unwrap, not
  exempting test targets workspace-wide. A new test file therefore has to ask.
- The `#[allow(unsafe_code)]` carve-out is in `crates/nostream-storage/src/backend.rs`
  around heed's `EnvOpenOptions::open`. Do not add a second one; do not widen
  `[workspace.lints.rust] unsafe_code` from `deny` to `forbid` (it would reject that
  audited call).

### The toolchain

`rust-toolchain.toml` pins it — channel `1.99.1`, `rustfmt` + `clippy`, `minimal` — and
every `cargo` invocation picks it up from the working directory. **Never pass a
version or `+stable` to a command**; edit the pin file if the toolchain must move, so
CI, contributors and build agents all move together.

## Crate layout

`crates/*`, one crate per module family, `edition = "2024"`, `rust-version = "1.99"`,
resolver 3:

| crate | owns |
|---|---|
| `nostream-core` | domain vocabulary: events, filters, kinds, wire messages, NIP type surfaces, `ShutdownState` |
| `nostream-config` | typed settings, loader, deep merge, validator, dot-path editor, redaction, guided catalogue |
| `nostream-storage` | event-store backends (LMDB via heed, Postgres), cache |
| `nostream-relay` | acceptor, connections, wire protocol, NIP-77 engine |
| `nostream-services` | NIP-66 monitors, Tor, schedulers, outbound work |
| `nostream-admin` | admin API and auth |
| `nostream-cli` | operator command line (`nostream-cli config validate`) |
| `nostreamd` | the daemon binary: runtime, telemetry, signals |

- Every crate manifest repeats `version.workspace = true`, `edition.workspace = true`,
  `rust-version.workspace = true`, `license.workspace = true`,
  `repository.workspace = true` and `[lints] workspace = true`. A new crate that omits
  the last one silently opts out of every workspace lint.
- **Dependencies go in `[workspace.dependencies]` and are referenced as
  `name.workspace = true`.** A version literal in a crate manifest is a second place to
  bump; do not add one.
- Each crate's `lib.rs` doc comment names the TypeScript paths it owns at the capture
  commit, and separately names what it deliberately does **not** own. Preserve both: a
  reader must be able to tell an omission from a gap.

## Error model

- **One error enum per crate, named `<Crate>Error`** (`CoreError`, `ConfigError`,
  `StorageError`, `DaemonError`, `CliError`), `thiserror::Error`, one variant per
  failure class, and a message written for an operator.
- **`anyhow` appears only in `crates/nostreamd/src/main.rs` and
  `crates/nostream-cli/src/main.rs`.** Everything else, including the CLI's own modules,
  returns `CliError`. The check CI's reviewers use:
  `grep -rn 'anyhow' crates/*/src/lib.rs` → empty.
- **A subsystem that is not implemented returns
  `Error::NotImplemented { module: "path::to::call" }` — never `todo!()`,
  `unimplemented!()` or `panic!()`.** The daemon's `main` maps that variant to exit code
  `1` with its message, and `DaemonError::InvalidSettings` to exit code `2`; keep those
  two distinct.
- Validation findings are **not** errors: `nostream_config::Issue { path, message }`
  carries a dot-path and the capture's exact message, and `Display` renders
  `{path}: {message}`. A validator that returns `Err` on a bad setting instead of an
  `Issue` changes the CLI's output contract.
- Settings validation messages are **byte-identical to the capture's**.
  `crates/nostream-config/tests/ts_parity.rs` replays every case in
  `tests/fixtures/ts-issues.json` (measured data, generated by
  `tests/capture/gen-ts-issues.mjs` against the capture commit) and requires the same
  issues, in the same order, with the same messages. **Exactly one path is exempt —
  `eventStore.backend`, because the rewrite adds the LMDB backend — and the exemption is
  recorded per case.** When a message or an exemption must change, change the fixture in
  the same commit and say why; never loosen the comparison to make a case pass.

## Porting discipline (this branch, phase 1)

- **Stubs are labelled, not hidden.** Every unimplemented item carries
  `/// Phase 1 stub — job 005; <what it will do>; see <TS path>` on the item, takes typed
  arguments, and returns `NotImplemented`. `grep -rn 'Phase 1 stub' crates` must count
  the stubs.
- **No silent `Ok(())`, no plausible fake data, no partial port.** A function that would
  need real behaviour returns the error. A `Result`-returning stub whose body is
  `Ok(Default::default())` is the failure mode this rule exists to prevent.
- The TypeScript tree is the specification. When Rust behaviour and a TS file disagree,
  the TS file wins unless a decision record says otherwise; the ADRs live in
  `docs/rewrite/decisions/` (`0001-runtime-and-telemetry.md` covers runtime, acceptor
  shape and telemetry) — read the relevant one before changing what it decided.

## Tests

- Unit tests live in `#[cfg(test)]` modules; integration tests in `crates/<crate>/tests/`.
  Prefer whole-behaviour tests at the public API: `crates/nostream-config/tests/load.rs`
  writes real fixtures to a `tempfile::TempDir` and calls the public loader, rather than
  asserting on internals.
- `unwrap`/`expect` are permitted in tests (the strict clippy pass excludes them) — use
  `expect("why this cannot fail")` so a failure names the assumption.
- A parity test that reads `resources/default-settings.yaml` or a fixture must fail, not
  skip, when the fixture is missing.

## Path filters — what triggers `Rust Checks`

`crates/**`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `scripts/rust.sh`,
`resources/default-settings.yaml` and the workflow file itself. A change to any other
file does **not** run the Rust job, so a change that alters what `cargo` sees (a new
fixture directory, a `.cargo/config.toml`) needs the filter extended in the same PR.
`resources/default-settings.yaml` joins **both** the TS and Rust filters because both
pipelines read it.

## Branch protection

`rewrite/main` has its own ruleset with eight required contexts: `Rust Checks`,
`Lint commits`, `Lint code`, `Lint PR title`, `Changeset Required`, `Build check`,
`Unit Tests And Coverage`, `Integration Tests and Coverage`. Adding or renaming a CI job
means updating that ruleset in the same release, or the branch becomes unmergeable.
