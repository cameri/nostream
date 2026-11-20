# ADR 0015: The operator CLI surface (job 034)

- **Status:** accepted (job 034, Phase 2)
- **Deciders:** the rewrite team, on the operator's decision recorded in #1184 and this job's spec
- **Date:** 2026-11-20

## Context

Issue #1184 is family (c) of #867: port `pnpm run cli` into `nostream-cli`. At the base commit
`982e6759` the crate had thirteen subcommand variants, of which ten were `Phase 1 stub` bodies
returning `CliError::NotImplemented` and exit 1, and three commands worked (`config validate`,
`config get`, `import`, `migrate pg-to-lmdb`). The capture's surface is 531 lines of `cac` and
eight command modules, and the two halves disagree on the things a script sees: the help page,
the stream each failure writes to, and the exit code per class.

The twelve decisions below are the ones a reader would otherwise have to reconstruct from the
diff. Each is recorded with its cost, because every one of them buys something by giving up
something else. D10 and D11 were added by the job's first review round: the `--older-than`
bound and the spawn seam were each decided in the code and had no decision to point at.

## Decisions

### D1 — The page is hand-written, and `--help`, no arguments and an unknown word are answered before the parser

`--help`, `-h` and an empty command line print the capture's page on **stdout** at exit 0; an
unknown first word prints `Unknown command: <word>` on **stderr** and the same page on
**stdout** at exit 2 (`src/cli/index.ts:470-531`, measured at the capture as 63 B stderr and
1209 B stdout). Only then does clap parse, so the parser never sees a case that has its own
answer.

The page is the capture's `cac` output with two edits — both lines that name `dev` are gone —
and the version line is the crate's own (D2). Per-command pages stay clap's, with the program
name `nostream` and the capture's flag spellings, value names and one-line descriptions
declared on the derive.

**Cost:** a script that greps `Usage:` from the bare invocation's **stderr** sees it on stdout
instead, and one that matched clap's `error: unrecognized subcommand` now matches
`Unknown command:` on stderr. Both are the point of the port.

### D2 — The version page is `nostream/<CARGO_PKG_VERSION>`

`-v` and `--version` print `nostream/0.1.0`, which is `env!("CARGO_PKG_VERSION")` and the same
string `info` prints as `Nostream v0.1.0` and the admin diagnostics serve
(`crates/nostream-admin/src/utils/diagnostics.rs:35`). The capture decorates the same value with
`linux-x64 node-v24.22.1`, which are Node's own platform and version and which this binary does
not have.

**Cost:** a script matching the decorated string has to drop two fields. This is the one place
the port deliberately differs from the capture's bytes rather than reproducing them.

### D3 — Three failure shapes, and the `Error: ` prefix belongs to the class

The capture writes `Error: ` in exactly one place: its top-level handler
(`printHandledError`, `src/cli/index.ts:40-42`), which runs only for a failure **thrown out of a
command**. A command that reports its own failure with `logError` never reaches it. The port
reproduces the split as three shapes:

- `CliError::Usage` and `CliError::Command` — `Error: <message>` on stderr, exit 2 and exit 1;
- `CliError::Config` and `CliError::Reported` — the lines verbatim, unprefixed, with the code
  the command chose;
- `CliError::Json` — `{"error":{"message":…,"code":N}}` on stderr, with the code.

Every command picks its shape from the capture's own class, site by site, never by convenience.

**Cost:** a classification a builder must follow message by message. Its value is that five
measured strings stay exactly as the capture prints them instead of being rewritten to a house
style.

### D4 — `start` and `stop` drive Docker Compose, not `nostreamd`

The tree holds no unit file, no pidfile and no daemonize path; `deploy/` holds the compose
overlays and two recreate scripts. `start` runs
`docker compose -f <each existing file> up --build --remove-orphans [-d] <passthrough>`, and
`stop` runs `down` over the overlays its flags name — with **no** flag meaning all four. Both
are the capture's argv byte for byte (`src/cli/commands/start.ts:89-141`,
`src/cli/commands/stop.ts:7-31`), and both are testable through a `PATH` shim with no daemon
anywhere.

**Cost:** a native supervisor is out of scope until the tree has the state for one. A
deployment that runs `nostreamd` under systemd would need its own control path, which is a
separate job with its own design.

### D5 — The storage seam is four methods, and the delete is a delete-list

`EventRepository` gains `scan_live` (the full-scan read `export` needs, because a filter read is
bounded by one page), `count_by_criteria` and `delete_by_criteria` (one `EventCleanCriteria`,
shared, so a `--dry-run` and the run that follows select the same rows), and
`delete_all_events` (the event-backed databases and nothing else). The retention API's
`EventRetentionOptions` is a **keep**-list and cannot express `clean-db`'s delete predicate:
`--kinds=4` with no age bound is not a whitelist anybody means.

The delete is **hard**, like the capture's `DELETE FROM events`, which is what makes a second
`--dry-run` report 0 instead of repeating the count.

**Cost:** two more trait methods, each implemented twice, plus the seven in-memory doubles'
implementations; and `delete_all_events` returns `()` because a Postgres `TRUNCATE` reports no
count.

### D6 — Three new dependencies and no prompt crate

`bech32` (a new `nostream_core::nip19` decoder, because NIP-43's `info.self` may be an `npub1…`
and the tree had no bech32 decoder at all), `flate2` (gzip) and `xz2` (xz, whose C build
`lmdb-master-sys` already makes ordinary here). `setup`'s two questions are a line reader over
stdin with `IsTerminal`, not a dependency.

**Cost:** `xz2` compiles C; if the Windows job ever fails on `lzma-sys`, the trigger is to gate
both codecs behind a default `compression` feature and build Windows with
`--no-default-features`. The line-reader prompt is not clack's box, and EOF on a read is the
cancel path because a line reader cannot see a Ctrl-C the way clack can.

### D7 — `info`'s uptime reads docker, and its signing key is derived

`docker compose ps -q nostream` and then `docker inspect --format {{.State.StartedAt}}`, each
inside a 1,000 ms bound, and `unavailable` when either cannot answer. `AdminState`'s uptime
belongs to the daemon's own process and is unreachable from a separate CLI without an
authenticated call and an HTTP client this crate does not have.

The signing pubkey is `nostream_relay::relay_key::RelayKeySource::try_public_key`, so
`nostream-cli` depends on `nostream-relay`. `RelayKeySource` stays where it is: core's charter is
domain vocabulary, and key derivation is not.

**Cost:** `info` reports `unavailable` for a daemon whose start time docker cannot see, and the
CLI gains a dependency on the relay crate. Moving `RelayKeySource` down to `nostream-core` is a
change of core's error enum and five relay call sites, and belongs to a job that is about that.

### D8 — `--data-dir <DIR>` names the store root

Every command that opens a store (`info`, `seed`, `invite`, `export`, `clean-db`) takes
`--data-dir`, and the LMDB store lives at `<DIR>/lmdb` — the layout
`migrate pg-to-lmdb --target` already writes. With the lmdb backend selected and no flag, the
command fails with `Error: the lmdb backend needs --data-dir <path>`.

**Cost:** there is no environment variable for the store root and none is invented; the
settings' `eventStore` carries only `backend`. When a deployment names the root somewhere, this
flag should read that same source.

### D9 — `config validate` keeps exit 2

The capture returns 1 there. The port keeps 2 and `settings valid: N issues`, because both are
shipped, tested (`crates/nostream-cli/tests/config_cli.rs:34-57`) and agreed with the daemon's
`DaemonError::InvalidSettings` → exit 2 mapping. Changing it would rewrite a tested contract to
match a command the issue does not name.

**Cost:** `config validate` is the one command whose code differs from the capture's, and it is
recorded here so the difference is a decision rather than a drift. `config get`'s not-found
message does move, to the capture's `Path not found: <path>` with no prefix: no test pinned the
old spelling.

### D10 — The `--older-than` cutoff saturates; it never becomes "no bound"

A day count past `MAX_SAFE_INTEGER` is refused at the parser with the capture's
`--older-than must be a positive integer`, because the capture refuses anything that is not a
safe positive integer (`src/clean-db.ts:54-65`). A value that is safe but too large to express as
a cutoff — `MAX_SAFE_INTEGER` days, about 2.5 × 10^14 years — is **saturated** to the earliest
representable instant (`i64::MIN`, via `checked_mul`/`checked_sub`) rather than refused with a
message the capture does not have. Saturating selects nothing, which is what the capture's own
comparison would do against a value no row's `created_at` is below.

**Cost:** the saturated cutoff is a value the capture would have to fail on rather than compare,
so the port's behaviour is a defensible reading of an unreachable branch rather than a measured
one. The alternative — a sixth parser message — was considered and rejected as a divergence from
a parser the criterion holds "case for case". The dangerous shape is neither: an unrepresentable
value must never become an *absent* bound, which is the defect this decision replaces.

### D11 — Child processes are opened in `nostream-services::process`, not in the CLI

The capture's CLI shells `docker`, `git`, `openssl` and `pnpm` itself (`src/cli/utils/process.ts`,
`docker.ts`). The rewrite's rule is that only `nostream-services` opens child processes and
sockets (`CLAUDE.md`'s crate table), so the seam lives there — `nostream_services::process::{run,
capture}` with five failure classes and a caller-owned runtime — and the CLI calls it. `start`,
`stop`, `update` and `info` are its only callers, and every argument reaches a child as one whole
argv element: no call site builds a shell string.

**Cost:** a dependency edge `nostream-cli → nostream-services` that the crate did not have, and a
seam whose shape is the services crate's rather than the CLI's. The gain is that the rule stays
true as the CLI grows, and that a reviewer can check one file instead of ten.

### D12 — An out-of-range `--kinds` value is refused where it becomes unrepresentable

`--kinds=4294967296` is a safe, non-negative integer, so the capture's parser accepts it and the
failure only arrives from its query; the port refuses it at the store, with
`event_kind is out of range: 4294967296` and exit 1, deleting nothing. The parser is not the
place: it cannot tell an out-of-range kind from a legitimate one, and the capture does not refuse
it there either. The port refuses at the point where the value would have to be coerced — which
is the defect this replaced, since coercing it to `i32::MAX` selected a kind the caller never
asked for and hard-deleted the rows carrying it.

**Cost:** a message the capture does not print, and one exit code (1) where the capture would
eventually fail from its own query. Refusing early is the choice because the alternative on LMDB
was a fabricated key, and because a kind beyond `u16`'s range cannot exist in a NIP-01 event.
