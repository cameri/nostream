//! The benchmark rig: one deterministic workload, measured through `Arc<dyn EventRepository>`
//! against the LMDB store or a scratch Postgres database.
//!
//! `docs/rewrite/benchmarks.md` cites the artifact this writes and nothing else, so the workload
//! lives here as named constants rather than in a file that could drift away from the harness:
//!
//! ```text
//! cargo run --release -p nostream-storage --example bench -- \
//!   --backend lmdb --events 50000 --seed 7 --out /tmp/bench.json --verify
//! ```
//!
//! Timings are never asserted and counts always are: `--verify` checks that the artifact records
//! the corpus it was asked for, so a run that measured a partial corpus, a filter that matched
//! nothing or a page that stopped early fails, while a slow host only makes the numbers large.
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

/// The corpus holds this many authors (`j = index % AUTHOR_COUNT`).
const AUTHOR_COUNT: u64 = 200;

/// The kind each corpus event takes, in order: `KIND_CYCLE[index % KIND_CYCLE.len()]`.
///
/// Replaceable kinds are absent on purpose: the relay writes kind 3 with `upsert`
/// (`strategies/contact_list.rs`), which is a different path from the `create` this measures.
const KIND_CYCLE: [u64; 10] = [1, 1, 1, 1, 1, 1, 1, 1, 7, 7];

/// The corpus content's length in bytes: 64 hex characters of the index, then `x`.
const CONTENT_LEN: usize = 256;

/// How many distinct `["t", "bench-<n>"]` values the corpus carries.
const TAG_VALUE_COUNT: u64 = 20;

/// The newest `created_at` any corpus event carries.
const CREATED_AT_ANCHOR_UNIX: i64 = 1_700_000_000;

/// The `created_at` spread below the anchor, and the window every read walks.
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

/// The corpus ceiling a run may not cross without `--allow-large-corpus`. A 1M-event corpus is
/// about 1.4 GB of `data.mdb`, so the default refusal is what keeps a mistyped `--events` from
/// filling a measuring host's disk.
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
    after_help = "The Postgres arm drops and recreates the scratch database named above on the server \
                  PARITY_ADMIN_URL points at, so run it only where that name is expendable. \
                  --store is refused with --backend postgres: the data lives in Postgres."
)]
struct Arguments {
    /// The store to measure.
    #[arg(long, value_enum)]
    backend: Backend,

    /// The corpus size; the ingest phase takes the last 1000 events of it.
    #[arg(long)]
    events: u64,

    /// The corpus seed: one seed produces one corpus and one set of read targets.
    #[arg(long, default_value_t = DEFAULT_SEED)]
    seed: u64,

    /// Where the JSON artifact is written.
    #[arg(long)]
    out: PathBuf,

    /// Check that the artifact records the corpus it was asked for.
    #[arg(long)]
    verify: bool,

    /// The store root for --backend lmdb; a fresh temporary directory when absent.
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
#[derive(Clone, Copy)]
struct ShapeCounts {
    name: &'static str,
    count: u64,
    rows: u64,
}

/// One shape's per-operation samples, reduced to the artifact's five fields.
struct Timing {
    ops: u64,
    p50_us: u64,
    p95_us: u64,
    p99_us: u64,
    per_second: u64,
}

impl Timing {
    fn from_samples(samples: &[u64]) -> Self {
        let mut sorted = samples.to_vec();
        sorted.sort_unstable();
        let total: u64 = sorted.iter().sum();
        let ops = sorted.len() as u64;
        Self {
            ops,
            p50_us: nearest_rank(&sorted, 50),
            p95_us: nearest_rank(&sorted, 95),
            p99_us: nearest_rank(&sorted, 99),
            // One operation's own rate: the whole shape's operations against the time they took.
            per_second: ops.saturating_mul(1_000_000) / total.max(1),
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
    timings: BTreeMap<&'static str, Vec<u64>>,
}

/// The artifact, minus `volatile`: everything here is identical between two runs of one command.
struct Report {
    backend: String,
    seed: u64,
    events: u64,
    event_count_read_back: u64,
    shapes: Vec<ShapeCounts>,
    timings: BTreeMap<String, Timing>,
}

/// One failed integrity check, reported as `verify failed: <field>: expected <x>, got <y>`.
struct VerifyFailure {
    field: String,
    expected: String,
    got: String,
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

    let (root, _temporary) = match &plan.store {
        Store::Given(path) => (path.clone(), None),
        Store::Temporary => {
            let directory = tempfile::tempdir()?;
            let path = directory.path().to_path_buf();
            (path, Some(directory))
        }
    };

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

    let measured = measure(store.as_ref(), plan.events, plan.seed).await?;

    let store_size = match plan.backend {
        Backend::Lmdb => {
            let data_bytes = std::fs::metadata(store_file(&root))?.len();
            Some(StoreSize {
                data_bytes,
                bytes_per_event: data_bytes / plan.events,
            })
        }
        Backend::Postgres => None,
    };

    let report = Report::new(plan.backend, plan.seed, plan.events, measured);
    let artifact = report.artifact(volatile_json(&report.timings, store_size.as_ref()));
    std::fs::write(
        &plan.out,
        format!("{}\n", serde_json::to_string_pretty(&artifact)?),
    )?;

    if plan.verify {
        let failures = verify(&report);
        for failure in &failures {
            eprintln!("{failure}");
        }
        return Ok(ExitCode::from(verify_exit_code(&failures)));
    }

    Ok(ExitCode::SUCCESS)
}

impl Plan {
    /// Answers every refusal before a store is opened, so a refused run leaves nothing behind.
    fn resolve(arguments: &Arguments) -> Fallible<Self> {
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
            return Err(refusal(
                "--store names an LMDB store and is only meaningful with --backend lmdb",
            ));
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

/// Event `index` of the corpus, for seed `seed`: identical input, identical bytes.
fn corpus_event(index: u64, seed: u64) -> Event {
    Event {
        id: event_id(index, seed),
        pubkey: author_pubkey(index % AUTHOR_COUNT, seed),
        created_at: CREATED_AT_ANCHOR_UNIX - (index % CREATED_AT_WINDOW_SECS as u64) as i64,
        kind: Kind(KIND_CYCLE[(index % KIND_CYCLE.len() as u64) as usize]),
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

/// Runs R4's phases in order and records one sample per operation.
async fn measure(store: &dyn EventRepository, events: u64, seed: u64) -> Fallible<Run> {
    let bulk_events = events - INGEST_EVENTS;
    let mut timings: BTreeMap<&'static str, Vec<u64>> = BTreeMap::new();
    let mut shapes = Vec::new();

    // 1. Bulk load: the first `events - INGEST_EVENTS` events, one `create_many` per batch.
    let mut samples = Vec::new();
    let mut rows = 0;
    let mut count = 0;
    let mut index = 0;
    while index < bulk_events {
        let end = (index + WRITE_BATCH as u64).min(bulk_events);
        let batch: Vec<EventRecord> = (index..end)
            .map(|event| EventRecord::from_event(&corpus_event(event, seed)))
            .collect();
        let started = Instant::now();
        rows += store.create_many(&batch).await?;
        samples.push(elapsed_us(started));
        count += 1;
        index = end;
    }
    timings.insert("create_many", samples);
    shapes.push(ShapeCounts {
        name: "create_many",
        count,
        rows,
    });

    // 2. Ingest: the corpus tail, one `create` per call, which is the relay's own write.
    let mut samples = Vec::new();
    let mut rows = 0;
    for index in bulk_events..events {
        let record = EventRecord::from_event(&corpus_event(index, seed));
        let started = Instant::now();
        rows += store.create(&record).await?;
        samples.push(elapsed_us(started));
    }
    timings.insert("create", samples);
    shapes.push(ShapeCounts {
        name: "create",
        count: INGEST_EVENTS,
        rows,
    });

    // 3. Read the whole corpus back once, which is what the unbounded count costs.
    let started = Instant::now();
    let event_count_read_back = store.count_by_filters(&[Filter::default()]).await?;
    timings.insert("read_back", vec![elapsed_us(started)]);

    // 4. The five read shapes, every target and window derived from the iteration and the seed.
    let (count, rows, samples) = read_shape(store, READ_ITERATIONS, |iteration| {
        let target = (seed * BY_ID_STRIDE + iteration * BY_ID_STRIDE + BY_ID_OFFSET) % events;
        vec![Filter {
            ids: Some(vec![event_id(target, seed).to_string()]),
            limit: Some(BY_ID_LIMIT),
            ..Filter::default()
        }]
    })
    .await?;
    timings.insert("by_id", samples);
    shapes.push(ShapeCounts {
        name: "by_id",
        count,
        rows,
    });

    let (count, rows, samples) = read_shape(store, READ_ITERATIONS, |iteration| {
        vec![Filter {
            authors: Some(vec![
                author_pubkey(iteration % AUTHOR_COUNT, seed).to_string(),
            ]),
            kinds: Some(vec![Kind::TEXT_NOTE]),
            limit: Some(AUTHOR_KIND_LIMIT),
            ..Filter::default()
        }]
    })
    .await?;
    timings.insert("author_kind", samples);
    shapes.push(ShapeCounts {
        name: "author_kind",
        count,
        rows,
    });

    let (count, rows, samples) = read_shape(store, READ_ITERATIONS, |iteration| {
        let since = CREATED_AT_ANCHOR_UNIX - CREATED_AT_WINDOW_SECS
            + (iteration as i64) * CREATED_AT_WINDOW_SECS / READ_ITERATIONS as i64;
        vec![Filter {
            kinds: Some(vec![Kind::TEXT_NOTE]),
            since: Some(since),
            limit: Some(KIND_SINCE_LIMIT),
            ..Filter::default()
        }]
    })
    .await?;
    timings.insert("kind_since", samples);
    shapes.push(ShapeCounts {
        name: "kind_since",
        count,
        rows,
    });

    let (count, rows, samples) = read_shape(store, READ_ITERATIONS, |iteration| {
        let tag_index = iteration % TAG_VALUE_COUNT;
        let mut tags = BTreeMap::new();
        tags.insert("#t".to_owned(), vec![format!("bench-{tag_index}")]);
        vec![Filter {
            tags,
            limit: Some(TAG_LIMIT),
            ..Filter::default()
        }]
    })
    .await?;
    timings.insert("tag", samples);
    shapes.push(ShapeCounts {
        name: "tag",
        count,
        rows,
    });

    let mut samples = Vec::new();
    let mut rows = 0;
    for iteration in 0..COUNT_ITERATIONS {
        let until = CREATED_AT_ANCHOR_UNIX
            - (iteration as i64) * CREATED_AT_WINDOW_SECS / COUNT_ITERATIONS as i64;
        let filters = [Filter {
            kinds: Some(vec![Kind::TEXT_NOTE]),
            until: Some(until),
            ..Filter::default()
        }];
        let started = Instant::now();
        rows += store.count_by_filters(&filters).await?;
        samples.push(elapsed_us(started));
    }
    timings.insert("count", samples);
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
    iterations: u64,
    filters: impl Fn(u64) -> Vec<Filter>,
) -> Fallible<(u64, u64, Vec<u64>)> {
    let mut samples = Vec::with_capacity(iterations as usize);
    let mut rows = 0;
    for iteration in 0..iterations {
        let filters = filters(iteration);
        let started = Instant::now();
        let records = collect_records(store.find_by_filters(&filters).await?).await?;
        samples.push(elapsed_us(started));
        rows += records.len() as u64;
    }
    Ok((iterations, rows, samples))
}

fn elapsed_us(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

impl Report {
    fn new(backend: Backend, seed: u64, events: u64, run: Run) -> Self {
        let timings = run
            .timings
            .into_iter()
            .map(|(name, samples)| (name.to_owned(), Timing::from_samples(&samples)))
            .collect();
        Self {
            backend: backend.name().to_owned(),
            seed,
            events,
            event_count_read_back: run.event_count_read_back,
            shapes: run.shapes,
            timings,
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
            "workload": workload_json(),
            "shapes": shapes,
            "volatile": volatile,
        })
    }
}

/// The workload the run measured, echoed so the artifact carries its own definition.
fn workload_json() -> Value {
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
    })
}

/// Everything that can differ between two runs: the host, the store's size and the timings.
fn volatile_json(timings: &BTreeMap<String, Timing>, store: Option<&StoreSize>) -> Value {
    let mut entries = Map::new();
    for (name, timing) in timings {
        entries.insert(
            name.clone(),
            json!({
                "ops": timing.ops,
                "p50_us": timing.p50_us,
                "p95_us": timing.p95_us,
                "p99_us": timing.p99_us,
                "per_second": timing.per_second,
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
        "timings": entries,
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

/// Every integrity check `--verify` makes; an empty list means the run recorded what it asked for.
fn verify(report: &Report) -> Vec<VerifyFailure> {
    let mut failures = Vec::new();
    let mut check = |field: String, expected: u64, got: u64| {
        if expected != got {
            failures.push(VerifyFailure {
                field,
                expected: expected.to_string(),
                got: got.to_string(),
            });
        }
    };

    check(
        "event_count_read_back".to_owned(),
        report.events,
        report.event_count_read_back,
    );

    let bulk_events = report.events - INGEST_EVENTS;
    let create_many = shape(report, "create_many");
    let create = shape(report, "create");

    check(
        "shapes[create_many].rows + shapes[create].rows".to_owned(),
        report.events,
        create_many.rows + create.rows,
    );
    check("shapes[create].rows".to_owned(), create.count, create.rows);
    // R6's `create_many.rows == count * create_many_batch` is this: every call wrote the batch it
    // was given. A bulk load that is not a whole number of batches ends in a short one, so the
    // expected total is the bulk event count, which is `count * batch` whenever it divides.
    check(
        "shapes[create_many].rows".to_owned(),
        bulk_events,
        create_many.rows,
    );
    check(
        "shapes[create_many].count".to_owned(),
        bulk_events.div_ceil(WRITE_BATCH as u64),
        create_many.count,
    );

    for (name, iterations) in [
        ("by_id", READ_ITERATIONS),
        ("author_kind", READ_ITERATIONS),
        ("kind_since", READ_ITERATIONS),
        ("tag", READ_ITERATIONS),
        ("count", COUNT_ITERATIONS),
    ] {
        let measured = shape(report, name);
        check(format!("shapes[{name}].count"), iterations, measured.count);
    }

    for measured in &report.shapes {
        if measured.rows == 0 {
            failures.push(VerifyFailure {
                field: format!("shapes[{}].rows", measured.name),
                expected: "> 0".to_owned(),
                got: measured.rows.to_string(),
            });
        }
    }

    for (name, timing) in &report.timings {
        let ordered = timing.p99_us >= timing.p95_us && timing.p95_us >= timing.p50_us;
        if !ordered {
            failures.push(VerifyFailure {
                field: format!("volatile.timings[{name}]"),
                expected: "p99_us >= p95_us >= p50_us".to_owned(),
                got: format!(
                    "{} >= {} >= {}",
                    timing.p99_us, timing.p95_us, timing.p50_us
                ),
            });
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

    fn valid_report() -> Report {
        let mut timings = BTreeMap::new();
        for name in [
            "create_many",
            "create",
            "by_id",
            "author_kind",
            "kind_since",
            "tag",
            "count",
            "read_back",
        ] {
            timings.insert(
                name.to_owned(),
                Timing {
                    ops: 10,
                    p50_us: 10,
                    p95_us: 20,
                    p99_us: 30,
                    per_second: 1_000,
                },
            );
        }
        Report {
            backend: "lmdb".to_owned(),
            seed: DEFAULT_SEED,
            events: 50_000,
            event_count_read_back: 50_000,
            shapes: vec![
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
                ShapeCounts {
                    name: "by_id",
                    count: READ_ITERATIONS,
                    rows: 200,
                },
                ShapeCounts {
                    name: "author_kind",
                    count: READ_ITERATIONS,
                    rows: 20_000,
                },
                ShapeCounts {
                    name: "kind_since",
                    count: READ_ITERATIONS,
                    rows: 50_000,
                },
                ShapeCounts {
                    name: "tag",
                    count: READ_ITERATIONS,
                    rows: 20_000,
                },
                ShapeCounts {
                    name: "count",
                    count: COUNT_ITERATIONS,
                    rows: 1_000_000,
                },
            ],
            timings,
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
        let timing = Timing::from_samples(&samples);
        assert_eq!(timing.p50_us, 100);
        assert_eq!(timing.p95_us, 190);
        assert_eq!(timing.p99_us, 198);
        assert_eq!(timing.ops, 200);
        assert_eq!(timing.per_second, 200 * 1_000_000 / 20_100);
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
        assert_eq!(failures.len(), 1, "one failure, not {}", failures.len());
        assert_eq!(failures[0].field, "shapes[tag].rows");
        assert_eq!(failures[0].expected, "> 0");
        assert_eq!(failures[0].got, "0");
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
}
