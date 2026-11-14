//! The benchmark rig: one deterministic workload, measured through `Arc<dyn EventRepository>`
//! against the LMDB store or a scratch Postgres database.
//!
//! `docs/rewrite/benchmarks.md` cites the artifact this writes and nothing else, so the workload
//! lives here as named constants rather than in a file that could drift away from the harness:
//!
//! ```text
//! cargo run --release -p nostream-storage --example bench -- \
//!   --backend lmdb --events 50000 --seed 7 --repeats 3 --verify --out /tmp/bench.json
//! ```
//!
//! Timings are never asserted and counts always are: `--verify` compares every count the
//! artifact records against what the corpus says the workload must produce, so a run that
//! measured a partial corpus, a filter that matched nothing, a page that stopped early or a
//! window that slid off the corpus fails, while a slow host only makes the numbers large.
//! Everything that can differ between two runs of one command sits under the single `volatile`
//! key, which is what makes two runs comparable as `jq -S 'del(.volatile)'`.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use clap::{Parser, ValueEnum};
use nostream_core::{Event, EventId, Filter, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::backend::{store_exists, store_file};
use nostream_storage::postgres::PostgresBackend;
use nostream_storage::repositories::{EventRecord, EventRepository, collect_records};
use serde_json::{Map, Value, json};
use sqlx::Executor;
use sqlx::postgres::PgPool;

/// The corpus holds this many authors (`author = index % AUTHOR_COUNT`).
const AUTHOR_COUNT: u64 = 200;

/// The kind each corpus event takes, in order: `KIND_CYCLE[cycle_position(index)]`.
///
/// Replaceable kinds are absent on purpose: the relay writes kind 3 with `upsert`
/// (`strategies/contact_list.rs`), which is a different path from the `create` this measures.
const KIND_CYCLE: [u64; 10] = [1, 1, 1, 1, 1, 1, 1, 1, 7, 7];

/// The kind the read shapes filter on, and the majority of the corpus.
const TEXT_NOTE: u64 = 1;

/// The corpus content's length in bytes: 64 hex characters of the index, then `x`.
const CONTENT_LEN: usize = 256;

/// How many distinct `["t", "bench-<n>"]` values the corpus carries.
const TAG_VALUE_COUNT: u64 = 20;

/// The newest `created_at` any corpus event carries.
const CREATED_AT_ANCHOR_UNIX: i64 = 1_700_000_000;

/// The `created_at` spread the corpus wraps around, and the bound every read window is derived
/// from.
const CREATED_AT_WINDOW_SECS: i64 = 2_592_000;

/// Events per `create_many` call: corpus loading, not ingest.
const WRITE_BATCH: usize = 500;

/// The corpus tail ingested one `create` per call, which is the relay's own ingest shape
/// (`crates/nostream-relay/src/strategies/default.rs`).
const INGEST_EVENTS: u64 = 1_000;

/// Iterations of each of the four filter read shapes.
const READ_ITERATIONS: u64 = 200;

/// Iterations of the `count` shape, which is the expensive read.
const COUNT_ITERATIONS: u64 = 50;

const BY_ID_LIMIT: u64 = 1;
const AUTHOR_KIND_LIMIT: u64 = 100;
const KIND_SINCE_LIMIT: u64 = 500;
const TAG_LIMIT: u64 = 100;

/// How many times the measured phases run in one invocation: the artifact carries the spread
/// across repeats, which is the only way a reader can tell a measurement from a lucky one.
const DEFAULT_REPEATS: u64 = 1;

/// The corpus ceiling a run may not cross without `--allow-large-corpus`. A 1M-event corpus is
/// about 1.9 GB of `data.mdb` at the rate this rig measures, so the default refusal is what
/// keeps a mistyped `--events` from filling a measuring host's disk.
const MAX_CORPUS_EVENTS: u64 = 200_000;

/// The per-event disk projection the large-corpus refusal prints: twice the worst measured
/// 2.1 KB/event, so the printed figure overstates rather than understates.
const BYTES_PER_EVENT_CEILING: u64 = 4_096;

/// The scratch database the Postgres arm drops and recreates on every run.
const SCRATCH_DATABASE: &str = "nostream_bench_rust";

const DEFAULT_SEED: u64 = 7;

/// `by_id` targets event `(seed * 7_919 + i * 7_919 + 13) % events`.
const BY_ID_STRIDE: u64 = 7_919;
const BY_ID_OFFSET: u64 = 13;

/// The shapes the artifact records, in the order it records them.
const SHAPES: [&str; 7] = [
    "create_many",
    "create",
    "by_id",
    "author_kind",
    "kind_since",
    "tag",
    "count",
];

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Backend {
    /// The embedded LMDB store, opened under `--store`.
    Lmdb,
    /// A scratch Postgres database, dropped and recreated through `PARITY_ADMIN_URL`.
    Postgres,
}

impl Backend {
    fn name(self) -> &'static str {
        match self {
            Self::Lmdb => "lmdb",
            Self::Postgres => "postgres",
        }
    }
}

/// One command line and one workload; everything the artifact records is fixed here.
#[derive(Parser)]
#[command(
    about = "Measures one deterministic workload against the LMDB store or a scratch Postgres database",
    after_help = "Exit codes: 0 the run completed, and with --verify every check passed; \
                  1 a verify failure, one `verify failed: <field>: expected <x>, got <y>` line per \
                  failed check, with the artifact written either way; 2 a usage error, a refusal, \
                  or a failure that stopped the run.\n\n\
                  --repeats N runs the measured phases N times, each against a fresh store (a \
                  --store directory gets one repeat-<n> subdirectory per run), and the artifact \
                  carries the spread across the repeats. The Postgres arm drops and recreates the \
                  scratch database named above on the server PARITY_ADMIN_URL points at, so run it \
                  only where that name is expendable."
)]
struct Arguments {
    /// The store to measure.
    #[arg(long, value_enum)]
    backend: Backend,

    /// The corpus size: at least 1000, and at most 200000 without --allow-large-corpus. The
    /// ingest phase takes the last 1000 events of it.
    #[arg(long)]
    events: u64,

    /// The corpus seed: one seed produces one corpus and one set of read targets.
    #[arg(long, default_value_t = DEFAULT_SEED)]
    seed: u64,

    /// How many times to run the measured phases; above 1 the artifact carries the spread.
    #[arg(long, default_value_t = DEFAULT_REPEATS)]
    repeats: u64,

    /// Where the JSON artifact is written; its directory must exist.
    #[arg(long)]
    out: PathBuf,

    /// Check that the artifact records the corpus it was asked for. The artifact is written
    /// whether or not the check passes.
    #[arg(long)]
    verify: bool,

    /// The store root for --backend lmdb; it must not already hold a store, and a fresh
    /// temporary directory is used when absent.
    #[arg(long)]
    store: Option<PathBuf>,

    /// Measure a corpus above the ceiling anyway.
    #[arg(long)]
    allow_large_corpus: bool,

    /// Measure beside a running compiler anyway.
    #[arg(long)]
    allow_busy_host: bool,
}

/// Where the store's data lives, resolved once so the refusal and the open cannot disagree.
enum Store {
    Temporary,
    Given(PathBuf),
}

/// The command line, after every refusal has been answered: no store has been touched yet.
struct Plan {
    backend: Backend,
    events: u64,
    seed: u64,
    repeats: u64,
    out: PathBuf,
    verify: bool,
    store: Store,
    admin_url: Option<String>,
}

/// How the run stopped: a refusal or a failure on stderr and exit 2, a verify failure exit 1.
#[derive(Debug)]
struct Refusal(String);

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for Refusal {}

type Fallible<T> = Result<T, Box<dyn Error>>;

fn refusal(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(Refusal(message.into()))
}

/// One shape's row accounting: how many operations were issued and what they returned.
#[derive(Clone, Copy, PartialEq, Eq)]
struct ShapeCounts {
    name: &'static str,
    count: u64,
    rows: u64,
}

/// One shape's per-operation samples, with the rows the shape returned in total.
struct Samples {
    values: Vec<u64>,
    rows: u64,
}

/// One shape's samples reduced to the artifact's fields.
struct Timing {
    ops: u64,
    p50_us: u64,
    p95_us: u64,
    p99_us: u64,
    per_second: u64,
    rows_per_second: u64,
}

impl Timing {
    fn from_samples(samples: &Samples) -> Self {
        let mut sorted = samples.values.clone();
        sorted.sort_unstable();
        let total: u64 = sorted.iter().sum();
        let ops = sorted.len() as u64;
        Self {
            ops,
            p50_us: nearest_rank(&sorted, 50),
            p95_us: nearest_rank(&sorted, 95),
            p99_us: nearest_rank(&sorted, 99),
            // Both rates are the shape's own integers against the time its calls took: one counts
            // operations, the other the rows those operations returned, and they differ by the
            // batch size for `create_many` rather than by a second denominator.
            per_second: ops.saturating_mul(1_000_000) / total.max(1),
            rows_per_second: samples.rows.saturating_mul(1_000_000) / total.max(1),
        }
    }
}

/// One shape's spread across repeats: the middle value and the tenth and ninetieth percentiles
/// of the per-run rate.
struct Band {
    median: u64,
    p10: u64,
    p90: u64,
}

impl Band {
    fn from_values(values: &[u64]) -> Self {
        let mut sorted = values.to_vec();
        sorted.sort_unstable();
        Self {
            median: nearest_rank(&sorted, 50),
            p10: nearest_rank(&sorted, 10),
            p90: nearest_rank(&sorted, 90),
        }
    }
}

/// The percentile the sample list carries: nearest rank over the sorted samples, index
/// `ceil(p/100 * n) - 1` clamped into the list, in whole microseconds.
fn nearest_rank(sorted: &[u64], p: u64) -> u64 {
    let len = sorted.len() as u64;
    if len == 0 {
        return 0;
    }
    let rank = (p * len).div_ceil(100).saturating_sub(1);
    sorted[rank.min(len - 1) as usize]
}

/// What one measured run leaves behind, before the machine and the store size are added.
struct Run {
    event_count_read_back: u64,
    shapes: Vec<ShapeCounts>,
    timings: BTreeMap<&'static str, Samples>,
}

/// The artifact, minus `volatile`: everything here is identical between two runs of one command.
struct Report {
    backend: String,
    seed: u64,
    events: u64,
    repeat_count: u64,
    event_count_read_back: u64,
    shapes: Vec<ShapeCounts>,
    timings: BTreeMap<String, Timing>,
    bands: BTreeMap<String, (Band, Band)>,
    /// Every repeat's shapes, so verification can check they agree with the first.
    repeat_shapes: Vec<Vec<ShapeCounts>>,
}

/// One failed integrity check, reported as `verify failed: <field>: expected <x>, got <y>`.
struct VerifyFailure {
    field: String,
    expected: String,
    got: String,
}

impl VerifyFailure {
    fn new(field: impl Into<String>, expected: impl Into<String>, got: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            expected: expected.into(),
            got: got.into(),
        }
    }
}

impl fmt::Display for VerifyFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self {
            field,
            expected,
            got,
        } = self;
        write!(
            formatter,
            "verify failed: {field}: expected {expected}, got {got}"
        )
    }
}

/// The `data.mdb` reading, which only the LMDB arm has.
struct StoreSize {
    data_bytes: u64,
    bytes_per_event: u64,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}

async fn run() -> Fallible<ExitCode> {
    let arguments = Arguments::parse();
    let plan = Plan::resolve(&arguments)?;

    eprintln!(
        "measuring {}: {} events at seed {}, {} repeat{}, artifact {}",
        plan.backend.name(),
        plan.events,
        plan.seed,
        plan.repeats,
        if plan.repeats == 1 { "" } else { "s" },
        plan.out.display()
    );

    let mut first: Option<Run> = None;
    let mut rest: Vec<Run> = Vec::new();
    let mut store_size = None;

    for repeat in 0..plan.repeats {
        let (root, _temporary) = store_root(&plan, repeat)?;
        let store: Arc<dyn EventRepository> = match plan.backend {
            Backend::Lmdb => Arc::new(LmdbBackend::open(&root).await?),
            Backend::Postgres => {
                let admin_url = plan
                    .admin_url
                    .as_deref()
                    .ok_or_else(|| refusal("--backend postgres needs PARITY_ADMIN_URL"))?;
                Arc::new(postgres_backend(admin_url).await?)
            }
        };

        let label = if plan.repeats == 1 {
            String::new()
        } else {
            format!("repeat {}/{}: ", repeat + 1, plan.repeats)
        };
        let measured = measure(store.as_ref(), plan.events, plan.seed, &label).await?;

        if plan.backend == Backend::Lmdb {
            let data_bytes = std::fs::metadata(store_file(&root))?.len();
            store_size = Some(StoreSize {
                data_bytes,
                bytes_per_event: data_bytes / plan.events,
            });
        }

        if first.is_none() {
            first = Some(measured);
        } else {
            rest.push(measured);
        }
    }

    let first = first.ok_or_else(|| refusal("--repeats must be at least 1"))?;
    let report = Report::new(plan.backend, plan.seed, plan.events, first, rest);
    let artifact = report.artifact(volatile_json(&report, store_size.as_ref()));

    let text = format!("{}\n", serde_json::to_string_pretty(&artifact)?);
    std::fs::write(&plan.out, text)
        .map_err(|error| refusal(format!("--out {}: {error}", plan.out.display())))?;

    if plan.verify {
        let failures = verify(&report);
        for failure in &failures {
            eprintln!("{failure}");
        }
        eprintln!(
            "wrote {}; verify: {}",
            plan.out.display(),
            if failures.is_empty() {
                "passed".to_owned()
            } else {
                format!("{} check{} failed", failures.len(), plural(failures.len()))
            }
        );
        return Ok(ExitCode::from(verify_exit_code(&failures)));
    }

    eprintln!("wrote {}", plan.out.display());
    Ok(ExitCode::SUCCESS)
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// The root one repeat opens its store under: a fresh temporary directory each time, and one
/// subdirectory per repeat under a `--store` root when the phases run more than once.
fn store_root(plan: &Plan, repeat: u64) -> Fallible<(PathBuf, Option<tempfile::TempDir>)> {
    match &plan.store {
        Store::Temporary => {
            let directory = tempfile::tempdir()?;
            let root = directory.path().to_path_buf();
            Ok((root, Some(directory)))
        }
        Store::Given(path) if plan.repeats == 1 => Ok((path.clone(), None)),
        Store::Given(path) => Ok((path.join(format!("repeat-{repeat}")), None)),
    }
}

impl Plan {
    /// Answers every refusal before a store is opened, so a refused run leaves nothing behind.
    fn resolve(arguments: &Arguments) -> Fallible<Self> {
        if arguments.repeats < 1 {
            return Err(refusal(
                "--repeats 0 asks for no measurement: pass 1 or more",
            ));
        }

        if arguments.events < INGEST_EVENTS {
            return Err(refusal(format!(
                "--events {} is below the minimum of {INGEST_EVENTS}: the ingest phase measures \
                 the last {INGEST_EVENTS} events",
                arguments.events
            )));
        }

        if arguments.events > MAX_CORPUS_EVENTS && !arguments.allow_large_corpus {
            return Err(refusal(format!(
                "--events {} is above the ceiling of {MAX_CORPUS_EVENTS} events, and the store \
                 would be about {} bytes at {BYTES_PER_EVENT_CEILING} bytes per event; pass \
                 --allow-large-corpus to measure it anyway",
                arguments.events,
                arguments.events.saturating_mul(BYTES_PER_EVENT_CEILING)
            )));
        }

        if !arguments.allow_busy_host
            && let Some(process) = compiling_process()
        {
            return Err(refusal(format!(
                "a compile is running: process {process} is rustc, and a build on this box \
                 distorts a measurement about threefold; wait for it to finish or pass \
                 --allow-busy-host"
            )));
        }

        if arguments.backend == Backend::Postgres && arguments.store.is_some() {
            let store = arguments
                .store
                .as_deref()
                .map(|path| path.display().to_string())
                .unwrap_or_default();
            return Err(refusal(format!(
                "--store {store} is only meaningful with --backend lmdb: the Postgres arm keeps \
                 its data in the scratch database it creates"
            )));
        }

        // The write happens after the whole measurement, so a mistyped directory has to be a
        // refusal like any other rather than a failure at the end of a long run.
        let parent = match arguments.out.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => PathBuf::from("."),
        };
        if !parent.is_dir() {
            return Err(refusal(format!(
                "--out {}: {} is not a directory. Create it and run again",
                arguments.out.display(),
                parent.display()
            )));
        }

        let admin_url = match arguments.backend {
            Backend::Postgres => Some(admin_url()?),
            Backend::Lmdb => None,
        };

        let store = match &arguments.store {
            Some(path) => {
                if store_exists(path) {
                    return Err(refusal(format!(
                        "--store {} already holds a store: {} exists. Choose another --store or \
                         remove it",
                        path.display(),
                        store_file(path).display()
                    )));
                }
                Store::Given(path.clone())
            }
            None => Store::Temporary,
        };

        Ok(Self {
            backend: arguments.backend,
            events: arguments.events,
            seed: arguments.seed,
            repeats: arguments.repeats,
            out: arguments.out.clone(),
            verify: arguments.verify,
            store,
            admin_url,
        })
    }
}

/// The administrative URL the Postgres arm creates its scratch database through, in the wording
/// `tests/parity.rs` and `tests/migrations.rs` already use.
fn admin_url() -> Fallible<String> {
    std::env::var("PARITY_ADMIN_URL").map_err(|_| {
        refusal(
            "PARITY_ADMIN_URL must name an administrative database, e.g. \
             postgres://postgres:postgres@host:5432/postgres",
        )
    })
}

/// The id of the first `rustc` in `/proc`, if one is alive: a build beside the measurement holds
/// the cores and distorts the numbers about threefold. `/proc` absent means no compiler to see.
fn compiling_process() -> Option<u32> {
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(process) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let comm = std::fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
        if comm.trim() == "rustc" {
            return Some(process);
        }
    }
    None
}

/// Drops the scratch database, creates it again, connects a backend to it and migrates it — the
/// sequence `tests/parity.rs` uses, duplicated here because an `examples/` target cannot import a
/// `tests/` module.
async fn postgres_backend(admin_url: &str) -> Fallible<PostgresBackend> {
    let admin = PgPool::connect(admin_url).await?;
    admin
        .execute(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {SCRATCH_DATABASE} WITH (FORCE)"
        )))
        .await?;
    admin
        .execute(sqlx::AssertSqlSafe(format!(
            "CREATE DATABASE {SCRATCH_DATABASE}"
        )))
        .await?;
    drop(admin);

    let backend = PostgresBackend::connect(&with_database(admin_url, SCRATCH_DATABASE)).await?;
    backend.migrate().await?;
    Ok(backend)
}

/// Replaces the database segment of a URL, keeping scheme, authority and parameters
/// (`tests/parity.rs`'s helper).
fn with_database(url: &str, database: &str) -> String {
    let (prefix, query) = match url.split_once('?') {
        Some((prefix, query)) => (prefix, Some(query)),
        None => (url, None),
    };
    let base = match prefix.rfind('/') {
        Some(index) if index > "postgres://".len() => &prefix[..index],
        _ => prefix,
    };
    match query {
        Some(query) => format!("{base}/{database}?{query}"),
        None => format!("{base}/{database}"),
    }
}

/// The cycle position event `index` takes.
///
/// The author's ordinal is added to the block the event falls in, so every author writes every
/// kind as the corpus advances — keying the kind on the index alone would give each author a
/// single kind, because `AUTHOR_COUNT` is a multiple of the cycle length — while every
/// `AUTHOR_COUNT`-event block still holds the cycle's proportions.
fn cycle_position(index: u64) -> usize {
    ((index % AUTHOR_COUNT + index / AUTHOR_COUNT) % KIND_CYCLE.len() as u64) as usize
}

/// Event `index` of the corpus, for seed `seed`: identical input, identical bytes.
fn corpus_event(index: u64, seed: u64) -> Event {
    Event {
        id: event_id(index, seed),
        pubkey: author_pubkey(index % AUTHOR_COUNT, seed),
        created_at: CREATED_AT_ANCHOR_UNIX - (index % CREATED_AT_WINDOW_SECS as u64) as i64,
        kind: Kind(KIND_CYCLE[cycle_position(index)]),
        tags: vec![vec![
            "t".to_owned(),
            format!("bench-{}", index % TAG_VALUE_COUNT),
        ]],
        // 64 hex characters of the index, then `x` to CONTENT_LEN: a fixed-width content that is
        // never a real note but costs what one costs to store.
        content: format!("{index:064x}{}", "x".repeat(CONTENT_LEN - 64)),
        // Nothing on the store path verifies a signature (`lmdb/events.rs` writes the record as
        // given), and signing would add a dependency to the timed path's build for no measurement.
        sig: Signature::from_byte_array([0; 64]),
    }
}

fn event_id(index: u64, seed: u64) -> EventId {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(&index.to_le_bytes());
    bytes[8..16].copy_from_slice(&seed.to_le_bytes());
    EventId::from_byte_array(bytes)
}

fn author_pubkey(author: u64, seed: u64) -> Pubkey {
    let mut bytes = [0u8; 32];
    bytes[..2].copy_from_slice(&(author as u16).to_le_bytes());
    bytes[2..10].copy_from_slice(&seed.to_le_bytes());
    Pubkey::from_byte_array(bytes)
}

/// The `created_at` span the corpus covers: one second per event until the window is full.
///
/// Every read window is derived from this rather than from [`CREATED_AT_WINDOW_SECS`], so a
/// window never slides off a corpus shorter than the window — which is what made the `count`
/// shape time an empty range for all but its first iteration.
fn corpus_span(events: u64) -> i64 {
    events.min(CREATED_AT_WINDOW_SECS as u64) as i64
}

fn since_for(iteration: u64, events: u64) -> i64 {
    let span = corpus_span(events);
    CREATED_AT_ANCHOR_UNIX - span + (iteration as i64) * span / READ_ITERATIONS as i64
}

fn until_for(iteration: u64, events: u64) -> i64 {
    let span = corpus_span(events);
    CREATED_AT_ANCHOR_UNIX - (iteration as i64) * span / COUNT_ITERATIONS as i64
}

fn by_id_target(iteration: u64, events: u64, seed: u64) -> u64 {
    (seed * BY_ID_STRIDE + iteration * BY_ID_STRIDE + BY_ID_OFFSET) % events
}

/// One read shape's filter for one iteration. The workload and the oracle both call this, so a
/// window that slides off the corpus shows up as an empty expectation rather than as two
/// independent mistakes.
fn read_filters(name: &str, iteration: u64, events: u64, seed: u64) -> Vec<Filter> {
    match name {
        "by_id" => {
            let target = by_id_target(iteration, events, seed);
            vec![Filter {
                ids: Some(vec![event_id(target, seed).to_string()]),
                limit: Some(BY_ID_LIMIT),
                ..Filter::default()
            }]
        }
        "author_kind" => vec![Filter {
            authors: Some(vec![
                author_pubkey(iteration % AUTHOR_COUNT, seed).to_string(),
            ]),
            kinds: Some(vec![Kind::TEXT_NOTE]),
            limit: Some(AUTHOR_KIND_LIMIT),
            ..Filter::default()
        }],
        "kind_since" => vec![Filter {
            kinds: Some(vec![Kind::TEXT_NOTE]),
            since: Some(since_for(iteration, events)),
            limit: Some(KIND_SINCE_LIMIT),
            ..Filter::default()
        }],
        "tag" => {
            let tag_index = iteration % TAG_VALUE_COUNT;
            let mut tags = BTreeMap::new();
            tags.insert("#t".to_owned(), vec![format!("bench-{tag_index}")]);
            vec![Filter {
                tags,
                limit: Some(TAG_LIMIT),
                ..Filter::default()
            }]
        }
        _ => vec![Filter {
            kinds: Some(vec![Kind::TEXT_NOTE]),
            until: Some(until_for(iteration, events)),
            ..Filter::default()
        }],
    }
}

/// The limit a read shape carries, or `None` for the unbounded `count`.
fn read_limit(name: &str) -> Option<u64> {
    match name {
        "by_id" => Some(BY_ID_LIMIT),
        "author_kind" => Some(AUTHOR_KIND_LIMIT),
        "kind_since" => Some(KIND_SINCE_LIMIT),
        "tag" => Some(TAG_LIMIT),
        _ => None,
    }
}

/// How many corpus events are `TEXT_NOTE` events among the first `count` indices — an index
/// range covers a `created_at` range because `created_at` falls as the index rises.
fn text_notes_in_range(lo: u64, hi: u64) -> u64 {
    let (lo, hi) = (lo.min(hi), hi);
    let mut total = 0;
    let mut index = lo;

    if index < hi {
        let block = index / AUTHOR_COUNT;
        let end = ((block + 1) * AUTHOR_COUNT).min(hi);
        total += text_notes_in_block(block, index % AUTHOR_COUNT, end - index);
        index = end;
    }

    let blocks = (hi - index) / AUTHOR_COUNT;
    total += blocks * text_notes_per_block();
    index += blocks * AUTHOR_COUNT;

    if index < hi {
        total += text_notes_in_block(index / AUTHOR_COUNT, 0, hi - index);
    }

    total
}

/// `TEXT_NOTE` events among `count` consecutive authors of one block, starting at `first_author`.
fn text_notes_in_block(block: u64, first_author: u64, count: u64) -> u64 {
    (0..count)
        .filter(|offset| {
            let author = first_author + offset;
            KIND_CYCLE[((author + block) % KIND_CYCLE.len() as u64) as usize] == TEXT_NOTE
        })
        .count() as u64
}

/// `TEXT_NOTE` events in one whole block: the cycle's share of `AUTHOR_COUNT`, whatever block
/// it is, because every author ordinal appears once per block.
fn text_notes_per_block() -> u64 {
    text_notes_in_block(0, 0, AUTHOR_COUNT)
}

/// Corpus events a shape's filter matches in one iteration, before the limit — the oracle's
/// expectation, derived from the corpus definition and not from what the store returned.
fn expected_matches(name: &str, iteration: u64, events: u64) -> u64 {
    match name {
        "by_id" => 1,
        "author_kind" => {
            let author = iteration % AUTHOR_COUNT;
            if author >= events {
                return 0;
            }
            let sorties = (events - author).div_ceil(AUTHOR_COUNT);
            let decades = sorties / KIND_CYCLE.len() as u64;
            let mut matches = decades * kind_cycle_notes();
            for offset in 0..sorties % KIND_CYCLE.len() as u64 {
                if KIND_CYCLE[((author % KIND_CYCLE.len() as u64 + offset)
                    % KIND_CYCLE.len() as u64) as usize]
                    == TEXT_NOTE
                {
                    matches += 1;
                }
            }
            matches
        }
        "tag" => {
            let value = iteration % TAG_VALUE_COUNT;
            if value >= events {
                0
            } else {
                (events - 1 - value) / TAG_VALUE_COUNT + 1
            }
        }
        "kind_since" => text_notes_since(events, since_for(iteration, events)),
        _ => text_notes_until(events, until_for(iteration, events)),
    }
}

/// `TEXT_NOTE` events the cycle holds, which is also the count over any run of
/// `KIND_CYCLE.len()` consecutive events.
fn kind_cycle_notes() -> u64 {
    KIND_CYCLE.iter().filter(|kind| **kind == TEXT_NOTE).count() as u64
}

/// `TEXT_NOTE` events with `created_at >= since`.
fn text_notes_since(events: u64, since: i64) -> u64 {
    let window = CREATED_AT_WINDOW_SECS as u64;
    let newest = CREATED_AT_ANCHOR_UNIX - since;
    if newest < 0 {
        return 0;
    }
    if newest as u64 >= window {
        return text_notes_in_range(0, events);
    }
    let newest = newest as u64;
    let mut total = 0;
    let mut cycle = 0;
    while cycle * window < events {
        let start = cycle * window;
        let end = (start + newest + 1).min(events);
        total += text_notes_in_range(start, end);
        cycle += 1;
    }
    total
}

/// `TEXT_NOTE` events with `created_at <= until`.
fn text_notes_until(events: u64, until: i64) -> u64 {
    let window = CREATED_AT_WINDOW_SECS as u64;
    let oldest = CREATED_AT_ANCHOR_UNIX - until;
    if oldest <= 0 {
        return text_notes_in_range(0, events);
    }
    if oldest as u64 >= window {
        return 0;
    }
    let oldest = oldest as u64;
    let mut total = 0;
    let mut cycle = 0;
    while cycle * window < events {
        let start = cycle * window + oldest;
        let end = ((cycle + 1) * window).min(events);
        if start < end {
            total += text_notes_in_range(start, end);
        }
        cycle += 1;
    }
    total
}

/// Runs R4's phases in order and records one sample per operation.
async fn measure(
    store: &dyn EventRepository,
    events: u64,
    seed: u64,
    label: &str,
) -> Fallible<Run> {
    let bulk_events = events - INGEST_EVENTS;
    let mut timings: BTreeMap<&'static str, Samples> = BTreeMap::new();
    let mut shapes = Vec::new();

    // 1. Bulk load: the first `events - INGEST_EVENTS` events, one `create_many` per batch.
    let mut values = Vec::new();
    let mut rows = 0;
    let mut count = 0;
    let mut index = 0;
    let load_started = Instant::now();
    while index < bulk_events {
        let end = (index + WRITE_BATCH as u64).min(bulk_events);
        let batch: Vec<EventRecord> = (index..end)
            .map(|event| EventRecord::from_event(&corpus_event(event, seed)))
            .collect();
        let started = Instant::now();
        rows += store.create_many(&batch).await?;
        values.push(elapsed_us(started));
        count += 1;
        index = end;
    }
    eprintln!(
        "{label}loaded {bulk_events} events in {} ms",
        load_started.elapsed().as_millis()
    );
    timings.insert("create_many", Samples { values, rows });
    shapes.push(ShapeCounts {
        name: "create_many",
        count,
        rows,
    });

    // 2. Ingest: the corpus tail, one `create` per call, which is the relay's own write.
    let mut values = Vec::new();
    let mut rows = 0;
    let ingest_started = Instant::now();
    for index in bulk_events..events {
        let record = EventRecord::from_event(&corpus_event(index, seed));
        let started = Instant::now();
        rows += store.create(&record).await?;
        values.push(elapsed_us(started));
    }
    eprintln!(
        "{label}ingested {INGEST_EVENTS} events in {} ms",
        ingest_started.elapsed().as_millis()
    );
    timings.insert("create", Samples { values, rows });
    shapes.push(ShapeCounts {
        name: "create",
        count: INGEST_EVENTS,
        rows,
    });

    // 3. Read the whole corpus back once, which is what the unbounded count costs.
    let started = Instant::now();
    let event_count_read_back = store.count_by_filters(&[Filter::default()]).await?;
    timings.insert(
        "read_back",
        Samples {
            values: vec![elapsed_us(started)],
            rows: event_count_read_back,
        },
    );

    // 4. The five read shapes, every target and window derived from the iteration and the seed.
    for name in ["by_id", "author_kind", "kind_since", "tag"] {
        let (count, rows, values) = read_shape(store, name, READ_ITERATIONS, seed, events).await?;
        timings.insert(name, Samples { values, rows });
        shapes.push(ShapeCounts { name, count, rows });
    }

    let mut values = Vec::new();
    let mut rows = 0;
    for iteration in 0..COUNT_ITERATIONS {
        let filters = read_filters("count", iteration, events, seed);
        let started = Instant::now();
        rows += store.count_by_filters(&filters).await?;
        values.push(elapsed_us(started));
    }
    timings.insert("count", Samples { values, rows });
    shapes.push(ShapeCounts {
        name: "count",
        count: COUNT_ITERATIONS,
        rows,
    });

    Ok(Run {
        event_count_read_back,
        shapes,
        timings,
    })
}

/// One filter read shape: `iterations` calls, each page drained to rows so the sample covers the
/// whole read. Returns the operations issued, the rows drained and one sample per call.
async fn read_shape(
    store: &dyn EventRepository,
    name: &str,
    iterations: u64,
    seed: u64,
    events: u64,
) -> Fallible<(u64, u64, Vec<u64>)> {
    let mut values = Vec::with_capacity(iterations as usize);
    let mut rows = 0;
    for iteration in 0..iterations {
        let filters = read_filters(name, iteration, events, seed);
        let started = Instant::now();
        let records = collect_records(store.find_by_filters(&filters).await?).await?;
        values.push(elapsed_us(started));
        rows += records.len() as u64;
    }
    Ok((iterations, rows, values))
}

fn elapsed_us(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

impl Report {
    fn new(backend: Backend, seed: u64, events: u64, first: Run, rest: Vec<Run>) -> Self {
        let repeat_count = 1 + rest.len() as u64;

        let mut timings = BTreeMap::new();
        let mut rates: BTreeMap<&'static str, (Vec<u64>, Vec<u64>)> = BTreeMap::new();
        let mut repeat_shapes = Vec::new();

        for run in std::iter::once(&first).chain(rest.iter()) {
            for (name, samples) in &run.timings {
                let timing = Timing::from_samples(samples);
                let entry = rates.entry(name).or_default();
                entry.0.push(timing.per_second);
                entry.1.push(timing.rows_per_second);
            }
            repeat_shapes.push(run.shapes.clone());
        }
        for (name, samples) in &first.timings {
            timings.insert((*name).to_owned(), Timing::from_samples(samples));
        }

        let bands = rates
            .into_iter()
            .map(|(name, (per_second, rows_per_second))| {
                (
                    name.to_owned(),
                    (
                        Band::from_values(&per_second),
                        Band::from_values(&rows_per_second),
                    ),
                )
            })
            .collect();

        Self {
            backend: backend.name().to_owned(),
            seed,
            events,
            repeat_count,
            event_count_read_back: first.event_count_read_back,
            shapes: first.shapes,
            timings,
            bands,
            repeat_shapes,
        }
    }

    fn artifact(&self, volatile: Value) -> Value {
        let shapes: Vec<Value> = self
            .shapes
            .iter()
            .map(|shape| {
                json!({
                    "shape": shape.name,
                    "count": shape.count,
                    "rows": shape.rows,
                })
            })
            .collect();
        json!({
            "backend": self.backend,
            "seed": self.seed,
            "events": self.events,
            "event_count_read_back": self.event_count_read_back,
            "workload": workload_json(self.repeat_count),
            "shapes": shapes,
            "volatile": volatile,
        })
    }
}

/// The workload the run measured, echoed so the artifact carries its own definition.
fn workload_json(repeat_count: u64) -> Value {
    json!({
        "corpus": {
            "authors": AUTHOR_COUNT,
            "kind_cycle": KIND_CYCLE,
            "content_len": CONTENT_LEN,
            "tag_value_count": TAG_VALUE_COUNT,
            "created_at_anchor_unix": CREATED_AT_ANCHOR_UNIX,
            "created_at_window_secs": CREATED_AT_WINDOW_SECS,
        },
        "writes": {
            "create_many_batch": WRITE_BATCH,
            "ingest_events": INGEST_EVENTS,
        },
        "reads": {
            "iterations": READ_ITERATIONS,
            "counts": COUNT_ITERATIONS,
            "limits": {
                "by_id": BY_ID_LIMIT,
                "author_kind": AUTHOR_KIND_LIMIT,
                "kind_since": KIND_SINCE_LIMIT,
                "tag": TAG_LIMIT,
            },
        },
        "concurrency": 1,
        "repeats": repeat_count,
    })
}

/// Everything that can differ between two runs: the host, the store's size, the timings and the
/// spread across repeats.
fn volatile_json(report: &Report, store: Option<&StoreSize>) -> Value {
    let mut timings = Map::new();
    for (name, timing) in &report.timings {
        timings.insert(
            name.clone(),
            json!({
                "ops": timing.ops,
                "p50_us": timing.p50_us,
                "p95_us": timing.p95_us,
                "p99_us": timing.p99_us,
                "per_second": timing.per_second,
                "rows_per_second": timing.rows_per_second,
            }),
        );
    }

    let mut repeats = Map::new();
    for (name, (per_second, rows_per_second)) in &report.bands {
        repeats.insert(
            name.clone(),
            json!({
                "per_second": {
                    "median": per_second.median,
                    "p10": per_second.p10,
                    "p90": per_second.p90,
                },
                "rows_per_second": {
                    "median": rows_per_second.median,
                    "p10": rows_per_second.p10,
                    "p90": rows_per_second.p90,
                },
            }),
        );
    }

    json!({
        "machine": {
            "cpu_count": cpu_count(),
            "cpu_model": cpu_model(),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "load_1min": load_1min(),
        },
        "store": match store {
            Some(size) => json!({
                "data_bytes": size.data_bytes,
                "bytes_per_event": size.bytes_per_event,
            }),
            None => json!({
                "data_bytes": Value::Null,
                "bytes_per_event": Value::Null,
            }),
        },
        "timings": timings,
        "repeats": repeats,
    })
}

fn cpu_count() -> u64 {
    std::thread::available_parallelism()
        .map(|count| count.get() as u64)
        .unwrap_or(0)
}

/// `/proc/cpuinfo`'s `model name`, absent where `/proc` is.
fn cpu_model() -> Option<String> {
    let info = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    info.lines().find_map(|line| {
        let rest = line.strip_prefix("model name")?;
        let (_, value) = rest.split_once(':')?;
        Some(value.trim().to_owned())
    })
}

/// `/proc/loadavg`'s one-minute figure, absent where `/proc` is.
fn load_1min() -> Option<f64> {
    let load = std::fs::read_to_string("/proc/loadavg").ok()?;
    load.split_whitespace().next()?.parse().ok()
}

/// Every integrity check `--verify` makes; an empty list means the run recorded what the corpus
/// says it must.
fn verify(report: &Report) -> Vec<VerifyFailure> {
    fn check(failures: &mut Vec<VerifyFailure>, field: String, expected: u64, got: u64) {
        if expected != got {
            failures.push(VerifyFailure::new(
                field,
                expected.to_string(),
                got.to_string(),
            ));
        }
    }

    let mut failures = Vec::new();

    let names: Vec<&str> = report.shapes.iter().map(|shape| shape.name).collect();
    if names != SHAPES.to_vec() {
        failures.push(VerifyFailure::new(
            "shapes",
            SHAPES.join(", "),
            names.join(", "),
        ));
    }

    check(
        &mut failures,
        "event_count_read_back".to_owned(),
        report.events,
        report.event_count_read_back,
    );

    let bulk_events = report.events - INGEST_EVENTS;
    let create_many = shape(report, "create_many");
    let create = shape(report, "create");

    check(
        &mut failures,
        "shapes[create_many].rows + shapes[create].rows".to_owned(),
        report.events,
        create_many.rows + create.rows,
    );
    check(
        &mut failures,
        "shapes[create].rows".to_owned(),
        create.count,
        create.rows,
    );
    // R6's `create_many.rows == count * create_many_batch` is this: every call wrote the batch it
    // was given. A bulk load that is not a whole number of batches ends in a short one, so the
    // expected total is the bulk event count, which is `count * batch` whenever it divides.
    check(
        &mut failures,
        "shapes[create_many].rows".to_owned(),
        bulk_events,
        create_many.rows,
    );
    check(
        &mut failures,
        "shapes[create_many].count".to_owned(),
        bulk_events.div_ceil(WRITE_BATCH as u64),
        create_many.count,
    );

    // The read shapes are checked against what the corpus says they must return, not against
    // "more than nothing": an empty window, a page stopped at its first batch and a selector
    // that stopped matching all record a smaller total, and all three passed the `rows > 0`
    // check this replaces.
    for name in ["by_id", "author_kind", "kind_since", "tag"] {
        let limit = read_limit(name).unwrap_or(0);
        let mut expected = 0;
        for iteration in 0..READ_ITERATIONS {
            let matches = expected_matches(name, iteration, report.events);
            if matches == 0 {
                failures.push(VerifyFailure::new(
                    format!("shapes[{name}].rows"),
                    "> 0 in every iteration",
                    format!("0 at iteration {iteration}"),
                ));
            }
            expected += matches.min(limit);
        }
        check(
            &mut failures,
            format!("shapes[{name}].rows"),
            expected,
            shape(report, name).rows,
        );
        check(
            &mut failures,
            format!("shapes[{name}].count"),
            READ_ITERATIONS,
            shape(report, name).count,
        );
    }

    let mut expected = 0;
    for iteration in 0..COUNT_ITERATIONS {
        let matches = expected_matches("count", iteration, report.events);
        if matches == 0 {
            failures.push(VerifyFailure::new(
                "shapes[count].rows",
                "> 0 in every iteration",
                format!("0 at iteration {iteration}"),
            ));
        }
        expected += matches;
    }
    check(
        &mut failures,
        "shapes[count].rows".to_owned(),
        expected,
        shape(report, "count").rows,
    );
    check(
        &mut failures,
        "shapes[count].count".to_owned(),
        COUNT_ITERATIONS,
        shape(report, "count").count,
    );

    for measured in &report.shapes {
        if measured.rows == 0 {
            failures.push(VerifyFailure::new(
                format!("shapes[{}].rows", measured.name),
                "> 0",
                measured.rows.to_string(),
            ));
        }
    }

    for (name, timing) in &report.timings {
        let ordered = timing.p99_us >= timing.p95_us && timing.p95_us >= timing.p50_us;
        if !ordered {
            failures.push(VerifyFailure::new(
                format!("volatile.timings[{name}]"),
                "p99_us >= p95_us >= p50_us",
                format!(
                    "{} >= {} >= {}",
                    timing.p99_us, timing.p95_us, timing.p50_us
                ),
            ));
        }
        check(
            &mut failures,
            format!("volatile.timings[{name}].ops"),
            timing.ops.max(1),
            timing.ops,
        );
        check(
            &mut failures,
            format!("volatile.timings[{name}].per_second"),
            timing.per_second.max(1),
            timing.per_second,
        );
        check(
            &mut failures,
            format!("volatile.timings[{name}].rows_per_second"),
            timing.rows_per_second.max(1),
            timing.rows_per_second,
        );
    }

    for (name, (per_second, rows_per_second)) in &report.bands {
        for (metric, band) in [
            ("per_second", per_second),
            ("rows_per_second", rows_per_second),
        ] {
            let ordered = band.p10 <= band.median && band.median <= band.p90;
            if !ordered {
                failures.push(VerifyFailure::new(
                    format!("volatile.repeats[{name}].{metric}"),
                    "p10 <= median <= p90",
                    format!("{} <= {} <= {}", band.p10, band.median, band.p90),
                ));
            }
        }
    }

    for (index, shapes) in report.repeat_shapes.iter().enumerate().skip(1) {
        for (first, repeat) in report.shapes.iter().zip(shapes.iter()) {
            if first != repeat {
                failures.push(VerifyFailure::new(
                    format!("repeats[{index}].shapes[{}]", first.name),
                    format!("count {} rows {}", first.count, first.rows),
                    format!("count {} rows {}", repeat.count, repeat.rows),
                ));
            }
        }
    }

    failures
}

fn shape(report: &Report, name: &str) -> ShapeCounts {
    report
        .shapes
        .iter()
        .find(|shape| shape.name == name)
        .copied()
        .unwrap_or(ShapeCounts {
            name: "",
            count: 0,
            rows: 0,
        })
}

/// A verify failure is exit 1; a run that verifies is exit 0.
fn verify_exit_code(failures: &[VerifyFailure]) -> u8 {
    if failures.is_empty() { 0 } else { 1 }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    const EVENTS: u64 = 50_000;

    fn valid_report() -> Report {
        let mut timings = BTreeMap::new();
        for name in SHAPES.iter().chain(std::iter::once(&"read_back")).copied() {
            timings.insert(
                name.to_owned(),
                Timing {
                    ops: 10,
                    p50_us: 10,
                    p95_us: 20,
                    p99_us: 30,
                    per_second: 1_000,
                    rows_per_second: 2_000,
                },
            );
        }
        let bands = timings
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    (
                        Band {
                            median: 1_000,
                            p10: 900,
                            p90: 1_100,
                        },
                        Band {
                            median: 2_000,
                            p10: 1_800,
                            p90: 2_200,
                        },
                    ),
                )
            })
            .collect();
        let mut shapes = vec![
            ShapeCounts {
                name: "create_many",
                count: 98,
                rows: 49_000,
            },
            ShapeCounts {
                name: "create",
                count: 1_000,
                rows: 1_000,
            },
        ];
        for name in ["by_id", "author_kind", "kind_since", "tag"] {
            let limit = read_limit(name).unwrap_or(0);
            let rows = (0..READ_ITERATIONS)
                .map(|iteration| expected_matches(name, iteration, EVENTS).min(limit))
                .sum();
            shapes.push(ShapeCounts {
                name,
                count: READ_ITERATIONS,
                rows,
            });
        }
        let rows = (0..COUNT_ITERATIONS)
            .map(|iteration| expected_matches("count", iteration, EVENTS))
            .sum();
        shapes.push(ShapeCounts {
            name: "count",
            count: COUNT_ITERATIONS,
            rows,
        });

        Report {
            backend: "lmdb".to_owned(),
            seed: DEFAULT_SEED,
            events: EVENTS,
            repeat_count: 1,
            event_count_read_back: EVENTS,
            repeat_shapes: vec![shapes.clone()],
            shapes,
            timings,
            bands,
        }
    }

    #[test]
    fn a_consistent_report_verifies() {
        let failures = verify(&valid_report());
        assert!(failures.is_empty(), "{} failures", failures.len());
    }

    #[test]
    fn percentiles_use_nearest_rank() {
        let samples: Vec<u64> = (1..=200).collect();
        let timing = Timing::from_samples(&Samples {
            values: samples,
            rows: 20_100,
        });
        assert_eq!(timing.p50_us, 100);
        assert_eq!(timing.p95_us, 190);
        assert_eq!(timing.p99_us, 198);
        assert_eq!(timing.ops, 200);
        assert_eq!(timing.per_second, 200 * 1_000_000 / 20_100);
        assert_eq!(timing.rows_per_second, 20_100 * 1_000_000 / 20_100);
    }

    #[test]
    fn bands_report_median_p10_p90() {
        let band = Band::from_values(&[30, 10, 20]);
        assert_eq!((band.p10, band.median, band.p90), (10, 20, 30));
        let band = Band::from_values(&[42]);
        assert_eq!((band.p10, band.median, band.p90), (42, 42, 42));
    }

    #[test]
    fn corpus_is_identical_for_a_seed() {
        let first: Vec<Event> = (0..1_000).map(|index| corpus_event(index, 7)).collect();
        let second: Vec<Event> = (0..1_000).map(|index| corpus_event(index, 7)).collect();
        assert_eq!(first, second);

        let left = serde_json::to_string(&first).unwrap();
        let right = serde_json::to_string(&second).unwrap();
        assert_eq!(left, right);

        let ids: std::collections::BTreeSet<_> = first.iter().map(|event| event.id).collect();
        assert_eq!(ids.len(), first.len(), "the corpus ids are distinct");
    }

    #[test]
    fn a_different_seed_changes_the_corpus() {
        assert_ne!(corpus_event(0, 7).id, corpus_event(0, 8).id);
        assert_ne!(corpus_event(0, 7).pubkey, corpus_event(0, 8).pubkey);
    }

    #[test]
    fn verify_rejects_a_short_read_back() {
        let mut report = valid_report();
        report.event_count_read_back = 49_999;
        let failures = verify(&report);
        assert_eq!(failures.len(), 1, "one failure, not {}", failures.len());
        assert_eq!(failures[0].field, "event_count_read_back");
        assert_eq!(failures[0].expected, "50000");
        assert_eq!(failures[0].got, "49999");
        assert_eq!(
            failures[0].to_string(),
            "verify failed: event_count_read_back: expected 50000, got 49999"
        );
    }

    #[test]
    fn verify_rejects_a_p95_below_p50() {
        let mut report = valid_report();
        let timing = report.timings.get_mut("by_id").expect("a by_id timing");
        timing.p50_us = 500;
        timing.p95_us = 400;
        let failures = verify(&report);
        assert_eq!(failures.len(), 1, "one failure, not {}", failures.len());
        assert_eq!(failures[0].field, "volatile.timings[by_id]");
    }

    #[test]
    fn verify_rejects_a_shape_with_no_rows() {
        let mut report = valid_report();
        let shape = report
            .shapes
            .iter_mut()
            .find(|shape| shape.name == "tag")
            .expect("a tag shape");
        shape.rows = 0;
        let failures = verify(&report);
        assert!(
            failures
                .iter()
                .any(|failure| failure.field == "shapes[tag].rows"),
            "no shapes[tag].rows failure in {failures:?}",
            failures = failures.len()
        );
    }

    #[test]
    fn verify_rejects_a_short_read_page() {
        let mut report = valid_report();
        let shape = report
            .shapes
            .iter_mut()
            .find(|shape| shape.name == "author_kind")
            .expect("an author_kind shape");
        // What a page truncated to its first batch, or an empty author range, would record.
        shape.rows = READ_ITERATIONS;
        let failures = verify(&report);
        assert_eq!(failures.len(), 1, "one failure, not {}", failures.len());
        assert_eq!(failures[0].field, "shapes[author_kind].rows");
        assert_eq!(failures[0].expected, "20000");
        assert_eq!(failures[0].got, "200");
    }

    #[test]
    fn verify_rejects_a_band_out_of_order() {
        let mut report = valid_report();
        let (per_second, _) = report.bands.get_mut("count").expect("a count band");
        // The median above the ninetieth percentile, while the tenth stays below it: only the
        // middle clause of the ordering catches this, so the test pins that clause too.
        per_second.median = per_second.p90 + 1;
        let failures = verify(&report);
        assert_eq!(failures.len(), 1, "one failure, not {}", failures.len());
        assert_eq!(failures[0].field, "volatile.repeats[count].per_second");
    }

    #[test]
    fn verify_rejects_a_repeat_that_disagrees() {
        let mut report = valid_report();
        let mut second = report.shapes.clone();
        second[0].rows -= 1;
        report.repeat_shapes.push(second);
        let failures = verify(&report);
        assert_eq!(failures.len(), 1, "one failure, not {}", failures.len());
        assert_eq!(failures[0].field, "repeats[1].shapes[create_many]");
    }

    #[test]
    fn a_verify_failure_exits_one() {
        let mut report = valid_report();
        report.event_count_read_back = 0;
        let failures = verify(&report);
        assert_eq!(verify_exit_code(&failures), 1);
        assert_eq!(verify_exit_code(&verify(&valid_report())), 0);
    }

    #[test]
    fn the_corpus_uses_only_kinds_in_the_cycle() {
        for index in 0..10_000 {
            let event = corpus_event(index, 7);
            assert!(
                KIND_CYCLE.contains(&event.kind.0),
                "event {index} has kind {}",
                event.kind
            );
        }
    }

    #[test]
    fn every_author_writes_both_kinds() {
        for author in 0..AUTHOR_COUNT {
            let kinds: std::collections::BTreeSet<u64> = (0..5_000)
                .filter(|index| index % AUTHOR_COUNT == author)
                .map(|index| corpus_event(index, 7).kind.0)
                .collect();
            assert_eq!(
                kinds,
                std::collections::BTreeSet::from([1, 7]),
                "author {author} writes {kinds:?}"
            );
        }
    }

    #[test]
    fn the_corpus_content_is_the_configured_length() {
        for index in 0..10_000 {
            let event = corpus_event(index, 7);
            assert_eq!(
                event.content.len(),
                CONTENT_LEN,
                "event {index} has {} bytes of content",
                event.content.len()
            );
            assert_eq!(event.tags.len(), 1);
            assert_eq!(event.tags[0][0], "t");
        }
    }

    #[test]
    fn every_read_window_matches_events_in_every_iteration() {
        for events in [1_000, 2_000, 5_000, 50_000] {
            for name in ["by_id", "author_kind", "kind_since", "tag", "count"] {
                let iterations = if name == "count" {
                    COUNT_ITERATIONS
                } else {
                    READ_ITERATIONS
                };
                for iteration in 0..iterations {
                    let matches = expected_matches(name, iteration, events);
                    assert!(
                        matches > 0,
                        "{name} at {events} events: iteration {iteration} matches nothing"
                    );
                }
            }
        }
    }

    #[test]
    fn expectations_match_the_corpus() {
        for events in [1_000u64, 2_000, 4_321] {
            let corpus: Vec<Event> = (0..events).map(|index| corpus_event(index, 7)).collect();
            for name in ["by_id", "author_kind", "kind_since", "tag", "count"] {
                let iterations = if name == "count" {
                    COUNT_ITERATIONS
                } else {
                    READ_ITERATIONS
                };
                let sampled = (0..iterations).step_by(17).chain([
                    0,
                    1,
                    iterations / 2,
                    iterations - 2,
                    iterations - 1,
                ]);
                for iteration in sampled {
                    let filters = read_filters(name, iteration, events, 7);
                    let matched = corpus
                        .iter()
                        .filter(|event| filters.iter().any(|filter| filter.matches(event)))
                        .count() as u64;
                    assert_eq!(
                        matched,
                        expected_matches(name, iteration, events),
                        "{name} at {events} events, iteration {iteration}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_expected_totals_are_the_ones_the_document_quotes() {
        let totals: Vec<(String, u64)> = ["by_id", "author_kind", "kind_since", "tag", "count"]
            .into_iter()
            .map(|name| {
                let limit = read_limit(name).unwrap_or(u64::MAX);
                let iterations = if name == "count" {
                    COUNT_ITERATIONS
                } else {
                    READ_ITERATIONS
                };
                let rows = (0..iterations)
                    .map(|iteration| expected_matches(name, iteration, EVENTS).min(limit))
                    .sum();
                (name.to_owned(), rows)
            })
            .collect();
        assert_eq!(
            totals,
            vec![
                ("by_id".to_owned(), 200),
                ("author_kind".to_owned(), 20_000),
                ("kind_since".to_owned(), 99_602),
                ("tag".to_owned(), 20_000),
                ("count".to_owned(), 1_020_000),
            ]
        );
    }
}
