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

The fourteen decisions below are the ones a reader would otherwise have to reconstruct from the
diff. Each is recorded with its cost, because every one of them buys something by giving up
something else. D10–D12 were added by the job's first review round and D13–D14 by its second and third: the
`--older-than` bound, the spawn seam and the out-of-range kind were decided in the code and had
no decision to point at; the clean-up delete's batch shape and the bootstrap's legacy-settings
guard are the same case.

## Decisions

### D1 — The page is hand-written, and four invocations are answered before the parser

`--help`, `-h` and an empty command line print the capture's page on **stdout** at exit 0; an
unknown first word prints `Unknown command: <word>` on **stderr** and the same page on
**stdout** at exit 2 (`src/cli/index.ts:470-531`, measured at the capture as 63 B stderr and
1209 B stdout). A fourth answer is the port's, added by the first review round: `start` with a
valueless `--port` (`start --port`, `start --port --detach`) is the port's own
`Error: Port must be a safe integer between 1 and 65535` at exit 1. That is a case clap *does*
answer — its missing-value error at exit 2 — and the arm deliberately overrides the class, which
is what `src/cli/commands/start.ts:74-78` measures: the capture reads its own `argv` for the flag
before its parser sees it. Only after those four does clap parse, so the parser never sees a case
that has its own answer.

The page is the capture's `cac` output with two edits — both lines that name `dev` are gone —
and the version line is the crate's own (D2). Per-command pages stay clap's, with the program
name `nostream` and the capture's flag spellings, value names and one-line descriptions
declared on the derive.

**Cost:** a script that greps `Usage:` from the bare invocation's **stderr** sees it on stdout
instead, one that matched clap's `error: unrecognized subcommand` now matches `Unknown command:`
on stderr, and the valueless `--port` moves a usage failure from exit 2 to exit 1 because the
message is the capture's, not the parser's. The page's own stream follows the same three rules:
a closed reader leaves the code alone and a full disk answers 1, except that a page which was a
failure's decoration keeps the failure's code.

### D2 — The version page is `nostream/<CARGO_PKG_VERSION>`

`-v` and `--version` print `nostream/0.1.0`, which is `env!("CARGO_PKG_VERSION")` and the same
string `info` prints as `Nostream v0.1.0` and the admin diagnostics serve
(`crates/nostream-admin/src/utils/diagnostics.rs:35`). The capture decorates the same value with
`linux-x64 node-v24.22.1`, which are Node's own platform and version and which this binary does
not have.

**Cost:** a script matching the decorated string has to drop two fields. It is not the port's
only deliberate divergence — D9's `config validate` exit 2, D10's saturation, D12's refusal
message and D13's partial count are each a byte or a code the capture does not print — but it is
the one divergence *of the version page*, which is what this decision is about.

### D3 — The failure shapes, and the `Error: ` prefix belongs to the class

The capture writes `Error: ` in exactly one place: its top-level handler
(`printHandledError`, `src/cli/index.ts:40-42`), which runs only for a failure **thrown out of a
command**. A command that reports its own failure with `logError` never reaches it. The port
reproduces the split as three shapes:

- `CliError::Usage` and `CliError::Command` — `Error: <message>` on stderr, exit 2 and exit 1;
- `CliError::Config` and `CliError::Reported` — the lines verbatim, unprefixed, with the code
  the command chose;
- `CliError::Json` — `{"error":{"message":…,"code":N}}` on stderr, with the code.

and one it composes: `CliError::ReportedAfter` carries data a command already **earned** and the
inner failure that followed. The earned lines go to **stdout**, where a successful run writes
them, and the inner failure keeps its own shape and code on **stderr**; nested wrappers flatten
outer-first. `render` still decides both, so the wrapper renders nothing itself
(`app::failure_lines` recurses into it). `config set --restart` is its one producer: the file is
written before the restart runs, so `Updated <path>` is a fact whatever the restart answers, and
the capture gets the split from that sequencing (`logInfo` at `src/cli/commands/config.ts:151`,
then `restartRelay` at `:154`, whose failures are the spinner's at `:65,71,75`) rather than from a
class of its own.

Every command picks its shape from the capture's own class, site by site, never by convenience.
The composed shape is the exception that proves the rule: the capture has no class for it, so it
is chosen by the outer command's sequencing, and a command may use it only for lines it has
already produced.

**Cost:** a classification a builder must follow message by message, plus two streams from one
invocation on the composed path and a shape the failure itself cannot name. Its value is that
five measured strings stay exactly as the capture prints them instead of being rewritten to a
house style.

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
capture}` with five failure classes and a caller-owned runtime — and the CLI calls it. Its callers
are `start`, `stop`, `update`, `info` and `clean` — the last spawns `docker system prune` and
`docker volume prune` — plus the two modules those commands drive: `compose.rs` (through `start`
and `stop`) and `bootstrap.rs` (the uid probe `start` runs first). Nine call sites in five files
(`bootstrap.rs`, `compose.rs`, `commands/clean.rs`, `commands/info.rs`, `commands/update.rs`).
The settings copy `start` also runs first is **not** a child process: it is `std::fs::copy`
(`bootstrap.rs:66`), and D14 governs when it may happen. Every argument reaches a child as one
whole argv element: no call site builds a shell string.

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

### D13 — The clean-up delete commits one batch of 10 000 rows, and a stopped run reports what it committed

`delete_by_criteria` walks the criteria's range in `CLEAN_BATCH_ROWS` rows at a time: one read
transaction collects a batch's ids, one write transaction deletes them (D5's delete-list). The
shape exists because LMDB has a single writer per environment: the first cut deleted inside one
write transaction and held that writer for the whole run — **19.46 s** in that cut's own run at
160 001 rows, before the curve existed; the sweep below re-measured the same shape at **17.94 s**,
and that is the figure every later comparison uses.

The batch size is the measured curve, not a guess, and the curve was taken at 160 001 rows on
this host with `CARGO_PROFILE_DEV_DEBUG=0` builds (one sweep, each shape run after the one above
it):

| batch | wall clock | write txns | mean writer hold |
|---|---|---|---|
| one transaction (the sweep's run) | 17.94 s | 1 | 17.94 s (held throughout) |
| 40 000 | 18.41–25.33 s | 5 | 5.02 s |
| **10 000** (shipped) | **28.15–31.52 s** | **17** | **1.83 s** |
| 1 000 | 80.61–129.06 s | 161 | 0.71–0.80 s |

A commit's cost does not shrink with the batch, so 161 of them add about 63 s that one does not.
10 000 is the end of the curve this decision takes: within 1.6× of the one-transaction wall clock,
with the writer released ten times sooner, and 17 commits rather than 161. 40 000 is the parity
point and gives the writer back for 5 s at a time; 1 000 is four and a half times the run for a
hold the next size up already nearly matches. The value is pinned by
`the_writer_is_released_between_batches`, which fails if a batch grows enough to make a 25 001-row
delete one transaction.

The price is written bytes. Deleting by the same criteria in one transaction wrote **1.41 MB**
through 15 write syscalls at 160 001 rows, because the pages it frees are marked loose and never
reach the disk; the 1 000-row shape wrote **5.31 GB** through 995 353 write syscalls, because
every commit's dirty set is written and every commit ends in one `fdatasync`. The file grows less
as a result — 69.8 MB against 242.9 MB at 160 001 rows — so the trade is growth for writes, not
gigabytes for nothing. The 10 000-row shape's write volume sits between the two and was not
measured; its commit count, which is what charges it, is 17.

Because the delete is no longer one atomic statement, a run **can** stop half-way, and the state
that leaves is reported rather than prevented: once a batch has committed, a later failure answers
`StorageError::Partial` carrying the rows already gone, and `nostream clean-db` prints it as its
one bare line at exit 1 — `4000 events were deleted before the failure: …`. The capture has no
such state: `src/clean-db.ts:211-216` is one `deleteQuery.del()`, which either removed every
selected row or none.

**Cost:** a `clean-db --older-than` over a large store is about 1.6× the wall clock of the single
statement it replaced, writes far more bytes than the rows it removes, and leaves behind a
half-deleted store the capture cannot produce — so a re-run is the operator's step after a
failure, and `--dry-run` (202 ms at 160 001 rows, one read walk) is the cheap way to learn what a
run will do.

### D14 — The bootstrap keeps a deployment's legacy `settings.json`

`ensureConfigBootstrap` in the capture copies the defaults into a config directory that has no
`settings.yaml`. The port copies them only when **neither** `settings.yaml` nor the deprecated
`settings.json` exists (`crates/nostream-cli/src/bootstrap.rs:52`), because the relay's loader
still falls back to `settings.json` and a deployment holding only that file would otherwise have
its admission policy, payment settings and limits replaced by the defaults on the first `start`
or `setup` — a silent override loss, not an error anyone would see.

**Cost:** a deliberate divergence from the capture's own condition, taken because the capture's
later fix does the same and because the alternative loses operator data without a message. Both
paths follow symlinks and treat a dangling link as absent, matching the loader
(`nostream-config/src/paths.rs:33-34` against `load.rs:168,178`); a dangling `settings.yaml` link
therefore makes the copy land through the link, outside the config directory — create-only,
fixed non-secret content, and predating this job. The `migrate` command's refusal of a source
named only in `.env` is the same kind of exception and is recorded here rather than left in a
doc comment: migration needs a source *and* a target, so a missing source is refused instead of
defaulted, unlike every other store command which reads the `.env` layer.
