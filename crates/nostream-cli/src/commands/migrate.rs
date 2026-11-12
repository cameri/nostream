//! `migrate pg-to-lmdb`: the copy of the Postgres store into an LMDB one.
//!
//! The seam is `nostream_storage::migration` — a paged read of each source table and an exact
//! write of each row, neither of which the nine repository traits can express. This module owns
//! what the seam's caller owns: the manifest, the checksum, resume, the verification pass and
//! the run's own measurement (`docs/rewrite/decisions/0012-pg-to-lmdb-migration.md`).
//!
//! The batch commits to the store first and the manifest is replaced atomically second, so a
//! crash between them replays one batch: every write is a put of the source's own key and
//! value, so the replay is idempotent and the merged entry is unchanged.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use nostream_storage::backend::{LMDB_DATA_FILE, LMDB_DIR};
use nostream_storage::migration::{MigratedTable, MigrationRow, MigrationSource, MigrationTarget};
use nostream_storage::{LmdbBackend, PostgresBackend};
use sha2::{Digest, Sha256};

use crate::config::CommandOutput;
use crate::error::CliError;

/// The manifest's file name under the target root.
const MANIFEST_FILE: &str = "migration-manifest.json";

/// The manifest format this tool writes.
const MANIFEST_FORMAT: u32 = 1;

/// The options one run carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrateOptions {
    /// The store root: the environment is `<target>/lmdb`, the manifest `<target>/migration-manifest.json`.
    pub target: PathBuf,
    /// Rows per batch, which is also the page size verify reads with.
    pub batch_size: usize,
    /// Verify the target against its manifest and copy nothing.
    pub verify: bool,
}

/// `migrate pg-to-lmdb`: the copy, or the verification pass when `verify` is set.
pub fn run(options: MigrateOptions, out: &mut dyn Write) -> Result<CommandOutput, CliError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| CliError::Config(format!("tokio runtime: {error}")))?;

    runtime.block_on(async move {
        if options.verify {
            // Both answered before anything is opened, so a verify of a directory that holds no
            // store leaves it exactly as it found it. The store is asked about first: R8's
            // missing store is `data.mdb`'s absence, which is also what a directory that never
            // held a migration looks like.
            if !store_present(&options) {
                return no_store(&options, out);
            }
            if read_manifest(&options.target)?.is_none() {
                return no_manifest(&options.target, out);
            }
            let target = open_existing_target(&options.target).await?;
            return verify_with(&target, &options, out).await;
        }

        // A complete manifest is verified rather than copied, and the source is never opened:
        // a finished migration must not need Postgres to still be reachable.
        if read_manifest(&options.target)?.is_some_and(|manifest| manifest.complete()) {
            if !store_present(&options) {
                return no_store(&options, out);
            }
            let target = open_existing_target(&options.target).await?;
            return verify_with(&target, &options, out).await;
        }

        let source = PostgresBackend::from_env()
            .await
            .map_err(|error| CliError::Migrate(error.to_string()))?;
        let target = open_target(&options.target).await?;
        migrate_with(&source, &target, &options, out).await
    })
}

/// The copy over an injected source, target and writer, which is how the whole run is tested
/// without a process and without a database.
///
/// Every batch's rows are written to the store and then folded into the manifest, which is
/// replaced after each batch; a batch that fails leaves the previous batch's `after`, `rows` and
/// `checksum` in place, so the next run resumes at the refused row.
pub async fn migrate_with(
    source: &dyn MigrationSource,
    target: &dyn MigrationTarget,
    options: &MigrateOptions,
    out: &mut dyn Write,
) -> Result<CommandOutput, CliError> {
    refuse_zero_batch(options)?;
    let existing = read_manifest(&options.target)?;
    let mut manifest = existing.clone().unwrap_or_else(Manifest::fresh);

    // A store that already holds rows and carries no manifest is not this tool's. Copying over
    // one leaves the displaced rows' index entries behind — a completed invoice keeps its
    // `invoices_pending` entry — and verify scans the primary databases only, so it could never
    // report them (R7).
    if existing.is_none()
        && let Some(table) = first_occupied_table(target).await?
    {
        return Err(CliError::Migrate(format!(
            "{} already holds rows ({}): an empty target, or one that carries a manifest, is required",
            options.target.display(),
            table.name()
        )));
    }

    // R6: written before the first `read_batch`, so a store this tool has begun to fill always
    // carries a manifest and a crash after the first batch resumes rather than being refused.
    if existing.is_none() {
        write_manifest(&options.target, &manifest)?;
    }

    if manifest.complete() {
        return verify_with(target, options, out).await;
    }

    let started = Instant::now();
    // The wall clock the summary reports: the last value is the one taken just after the last
    // `write_batch` of this run.
    let mut measured: Option<Duration> = None;
    let mut total = 0u64;
    let mut events = 0u64;

    for table in MigratedTable::ALL {
        let entry = manifest.get(table);
        if entry.complete {
            continue;
        }
        let mut rows = entry.rows;
        let mut sum = RowSum::from_hex(&entry.checksum)?;
        let mut after = decode_key(&entry.after)?;

        loop {
            let batch = source
                .read_batch(table, after.as_deref(), options.batch_size)
                .await
                .map_err(|error| table_failed(table, &error))?;
            let count = batch.len();
            let written = target
                .write_batch(&batch)
                .await
                .map_err(|error| table_failed(table, &error))?;
            measured = Some(started.elapsed());

            for row in &batch {
                sum.add(row)?;
            }
            rows += written;
            total += written;
            if table == MigratedTable::Events {
                events += written;
            }
            if let Some(last) = batch.last() {
                after = Some(last.key());
            }

            let complete = count < options.batch_size;
            let entry = manifest.entry(table);
            entry.rows = rows;
            entry.checksum = sum.to_hex();
            entry.after = after.as_deref().map(hex::encode).unwrap_or_default();
            entry.complete = complete;
            write_manifest(&options.target, &manifest)?;

            if complete {
                break;
            }
        }
    }

    let ms = u64::try_from(measured.unwrap_or_default().as_millis()).unwrap_or(u64::MAX);
    let rate = events.saturating_mul(1_000) / ms.max(1);
    writeln!(out, "Migrated {total} rows in {ms} ms").map_err(write_failed)?;
    writeln!(out, "Events throughput: {rate} events/s").map_err(write_failed)?;

    Ok(CommandOutput::default())
}

/// The verification pass: fold each table in the store the way the copy folded it, and compare
/// the nine entries with the manifest.
///
/// Every table is paged to its end, so a table longer than one page is read rather than cut at
/// its first. The pass writes nothing to the store and never opens the source.
pub async fn verify_with(
    target: &dyn MigrationTarget,
    options: &MigrateOptions,
    out: &mut dyn Write,
) -> Result<CommandOutput, CliError> {
    refuse_zero_batch(options)?;
    let Some(manifest) = read_manifest(&options.target)? else {
        return no_manifest(&options.target, out);
    };

    let mut failures: Vec<String> = Vec::new();
    let mut total = 0u64;

    for table in MigratedTable::ALL {
        let entry = manifest.get(table);
        let mut rows = 0u64;
        let mut sum = RowSum::default();
        let mut after: Option<Vec<u8>> = None;

        loop {
            let page = target
                .scan_batch(table, after.as_deref(), options.batch_size)
                .await
                .map_err(|error| table_failed(table, &error))?;
            let count = page.len();
            for row in &page {
                sum.add(row)?;
            }
            rows += count as u64;
            if let Some(last) = page.last() {
                after = Some(last.key());
            }
            if count < options.batch_size {
                break;
            }
        }
        total += rows;

        if rows != entry.rows {
            failures.push(format!(
                "[{}] manifest {} rows, target {rows} rows",
                table.name(),
                entry.rows
            ));
        } else if sum.to_hex() != entry.checksum {
            failures.push(format!(
                "[{}] checksum mismatch (manifest {}, target {})",
                table.name(),
                entry.checksum,
                sum.to_hex()
            ));
        } else if !entry.complete {
            failures.push(format!("[{}] the manifest is incomplete", table.name()));
        }
    }

    if failures.is_empty() {
        writeln!(
            out,
            "Verified {} tables, {total} rows",
            MigratedTable::ALL.len()
        )
        .map_err(write_failed)?;
        return Ok(CommandOutput::default());
    }

    for line in &failures {
        writeln!(out, "{line}").map_err(write_failed)?;
    }
    Ok(CommandOutput {
        lines: Vec::new(),
        exit_code: 1,
    })
}

/// The manifest: one entry per table, and the two tables this tool does not move.
///
/// It carries no timestamp, rate or path, so two runs over the same source produce the same
/// bytes and a resumed run's manifest is the clean run's.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Manifest {
    format: u32,
    not_migrated: Vec<String>,
    tables: BTreeMap<String, TableEntry>,
}

impl Manifest {
    /// The manifest a first run starts from: every table empty and incomplete.
    fn fresh() -> Self {
        Self {
            format: MANIFEST_FORMAT,
            not_migrated: MigratedTable::NOT_MIGRATED
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
            tables: MigratedTable::ALL
                .iter()
                .map(|table| (table.name().to_owned(), TableEntry::default()))
                .collect(),
        }
    }

    /// This table's entry, as the empty one when the manifest carries none.
    fn get(&self, table: MigratedTable) -> TableEntry {
        self.tables.get(table.name()).cloned().unwrap_or_default()
    }

    /// This table's entry, created empty when the manifest carries none.
    fn entry(&mut self, table: MigratedTable) -> &mut TableEntry {
        self.tables.entry(table.name().to_owned()).or_default()
    }

    /// Whether every table has been copied to its end.
    fn complete(&self) -> bool {
        MigratedTable::ALL
            .iter()
            .all(|table| self.get(*table).complete)
    }
}

/// One table's accumulated state: what the copy has written and where it resumes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct TableEntry {
    /// The rows the table's batches have written.
    rows: u64,
    /// The hex of the table's running row sum; sixty-four `0` characters when it is empty.
    checksum: String,
    /// The hex of the last written key; empty before the first batch.
    after: String,
    /// True once a read returned fewer rows than the batch size.
    complete: bool,
}

impl Default for TableEntry {
    fn default() -> Self {
        Self {
            rows: 0,
            checksum: RowSum::default().to_hex(),
            after: String::new(),
            complete: false,
        }
    }
}

/// The manifest's 256-bit row sum.
///
/// For every row it adds `SHA-256(len32 ‖ key ‖ canonical)` into a wrapping 256-bit sum. The sum
/// is order-independent, needs constant memory, and composes across a resume
/// (`sum(A ∪ B) = sum(A) + sum(B)`); it detects an added, removed or altered row and is stated
/// as a corruption and completeness check, not as a cryptographic commitment
/// (`docs/rewrite/decisions/0012-pg-to-lmdb-migration.md`, D4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct RowSum([u64; 4]);

impl RowSum {
    /// Adds one row's digest.
    fn add(&mut self, row: &MigrationRow) -> Result<(), CliError> {
        let key = row.key();
        let length = u32::try_from(key.len())
            .map_err(|_| CliError::Migrate("a row key is longer than 4 GiB".to_owned()))?;
        let canonical = row
            .canonical()
            .map_err(|error| CliError::Migrate(error.to_string()))?;

        let mut hasher = Sha256::new();
        hasher.update(length.to_be_bytes());
        hasher.update(&key);
        hasher.update(&canonical);
        let digest = hasher.finalize();
        let (words, _) = digest.as_chunks::<8>();
        for (limb, word) in self.0.iter_mut().zip(words) {
            *limb = limb.wrapping_add(u64::from_be_bytes(*word));
        }
        Ok(())
    }

    /// The sum a manifest entry carries, as its sixty-four hex characters.
    fn from_hex(text: &str) -> Result<Self, CliError> {
        let mut bytes = [0u8; 32];
        hex::decode_to_slice(text, &mut bytes).map_err(|error| {
            CliError::Migrate(format!(
                "the manifest's checksum is not 64 hexadecimal characters: {error}"
            ))
        })?;
        let mut limbs = [0u64; 4];
        let (words, _) = bytes.as_chunks::<8>();
        for (limb, word) in limbs.iter_mut().zip(words) {
            *limb = u64::from_be_bytes(*word);
        }
        Ok(Self(limbs))
    }

    /// The sum as sixty-four lowercase hex characters.
    fn to_hex(self) -> String {
        let mut bytes = [0u8; 32];
        let (words, _) = bytes.as_chunks_mut::<8>();
        for (word, limb) in words.iter_mut().zip(self.0) {
            *word = limb.to_be_bytes();
        }
        hex::encode(bytes)
    }
}

/// The manifest's path under a target root.
fn manifest_path(target: &Path) -> PathBuf {
    target.join(MANIFEST_FILE)
}

/// A comma-separated list, or `none`, for a refusal that names what it found.
fn named_list(names: &[&str]) -> String {
    if names.is_empty() {
        "none".to_owned()
    } else {
        names.join(", ")
    }
}

/// The manifest at the target, or `None` when there is none.
fn read_manifest(target: &Path) -> Result<Option<Manifest>, CliError> {
    let path = manifest_path(target);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CliError::Migrate(format!("{}: {error}", path.display()))),
    };
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", path.display())))?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(CliError::Migrate(format!(
            "{}: manifest format {} is not supported; this tool reads and writes {MANIFEST_FORMAT}",
            path.display(),
            manifest.format
        )));
    }

    // A manifest is this tool's only when it describes all nine tables and the two it leaves
    // alone. `Manifest::get` answers an empty entry for a table the file does not name, so a
    // partial file would restart every table at `rows: 0` over a store of unknown contents and
    // skip R7's refusal entirely.
    let named: BTreeSet<&str> = manifest.tables.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = MigratedTable::ALL
        .iter()
        .map(|table| table.name())
        .collect();
    if named != expected {
        let missing: Vec<&str> = expected.difference(&named).copied().collect();
        let unknown: Vec<&str> = named.difference(&expected).copied().collect();
        return Err(CliError::Migrate(format!(
            "{}: the manifest does not name this tool's nine tables (missing: {}; unknown: {})",
            path.display(),
            named_list(&missing),
            named_list(&unknown)
        )));
    }
    if manifest.not_migrated != MigratedTable::NOT_MIGRATED {
        let named: Vec<&str> = manifest.not_migrated.iter().map(String::as_str).collect();
        return Err(CliError::Migrate(format!(
            "{}: the manifest's not_migrated is not the two tables this tool leaves alone (it \
             names: {})",
            path.display(),
            named_list(&named)
        )));
    }
    Ok(Some(manifest))
}

/// Replaces the manifest through a temporary file, so a reader never sees a half-written one.
fn write_manifest(target: &Path, manifest: &Manifest) -> Result<(), CliError> {
    let path = manifest_path(target);
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", path.display())))?;
    fs::write(&temporary, &bytes)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", temporary.display())))?;
    fs::rename(&temporary, &path)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", path.display())))
}

/// The line and exit code a verify answers when the target has no manifest.
fn no_manifest(target: &Path, out: &mut dyn Write) -> Result<CommandOutput, CliError> {
    writeln!(out, "No manifest at {}", manifest_path(target).display()).map_err(write_failed)?;
    Ok(CommandOutput {
        lines: Vec::new(),
        exit_code: 1,
    })
}

/// The line and exit code a verify answers when the target has a manifest but no store.
fn no_store(options: &MigrateOptions, out: &mut dyn Write) -> Result<CommandOutput, CliError> {
    writeln!(out, "No store at {}", store_path(options).display()).map_err(write_failed)?;
    Ok(CommandOutput {
        lines: Vec::new(),
        exit_code: 1,
    })
}

/// The store's directory under a target root: the environment `LmdbBackend::open` would create.
fn store_path(options: &MigrateOptions) -> PathBuf {
    options.target.join(LMDB_DIR)
}

/// Whether the target already holds an LMDB environment, asked the way R8 asks it: `<target>/
/// lmdb/data.mdb` is a file. A directory alone is not a store, and neither is a lock file.
fn store_present(options: &MigrateOptions) -> bool {
    store_path(options).join(LMDB_DATA_FILE).is_file()
}

/// The first table of a manifest-less target that already holds a row, if any: one row read per
/// table, which is the probe R7 asks for.
async fn first_occupied_table(
    target: &dyn MigrationTarget,
) -> Result<Option<MigratedTable>, CliError> {
    for table in MigratedTable::ALL {
        let rows = target
            .scan_batch(table, None, 1)
            .await
            .map_err(|error| table_failed(table, &error))?;
        if !rows.is_empty() {
            return Ok(Some(table));
        }
    }
    Ok(None)
}

/// A batch of zero never advances a cursor. The parser refuses it, and these two entry points are
/// public, so they refuse it themselves rather than loop.
fn refuse_zero_batch(options: &MigrateOptions) -> Result<(), CliError> {
    if options.batch_size == 0 {
        return Err(CliError::Migrate(
            "--batch-size must be at least 1".to_owned(),
        ));
    }
    Ok(())
}

/// Opens the store a copy writes, creating it when it is not there.
async fn open_target(root: &Path) -> Result<LmdbBackend, CliError> {
    LmdbBackend::open(root)
        .await
        .map_err(|error| CliError::Migrate(error.to_string()))
}

/// Opens the store a verify reads, read-only and creating nothing (R8).
async fn open_existing_target(root: &Path) -> Result<LmdbBackend, CliError> {
    LmdbBackend::open_existing(root)
        .await
        .map_err(|error| CliError::Migrate(error.to_string()))
}

/// A failure of one table's read or write, naming the table so an operator knows which row
/// stopped the run.
fn table_failed(table: MigratedTable, error: &dyn std::fmt::Display) -> CliError {
    CliError::Migrate(format!("{}: {error}", table.name()))
}

/// One hex resume cursor, or `None` before the table's first batch.
fn decode_key(text: &str) -> Result<Option<Vec<u8>>, CliError> {
    if text.is_empty() {
        return Ok(None);
    }
    hex::decode(text).map(Some).map_err(|error| {
        CliError::Migrate(format!(
            "the manifest's resume cursor is not hexadecimal: {error}"
        ))
    })
}

/// A write failure is an error, not a success with nothing delivered.
fn write_failed(error: std::io::Error) -> CliError {
    CliError::Migrate(format!("unable to write the migration's output: {error}"))
}
