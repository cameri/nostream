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
use std::io;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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
        refuse_unsafe_target(&options)?;

        if options.verify {
            // Both answered before anything is opened, so a verify of a directory that holds no
            // store is refused rather than given a fresh empty one. The store is asked about by
            // its file for the same reason: R8's missing store is `data.mdb`'s absence, and a
            // directory that never held a migration looks exactly like it. Verify creates no
            // store and no manifest; LMDB's read-only open still recreates `lock.mdb` beside an
            // existing `data.mdb`, which is the one thing it writes.
            if !store_present(&options) {
                return no_store(&options, out);
            }
            if read_manifest(&options.target)?.is_none() {
                return no_manifest(&options.target, out);
            }
            let target = open_existing_target(&options.target).await?;
            return verify_with(&target, &options, out).await;
        }

        let existing = read_manifest(&options.target)?;

        // A complete manifest is verified rather than copied, and the source is never opened:
        // a finished migration must not need Postgres to still be reachable.
        if existing
            .as_ref()
            .is_some_and(|manifest| manifest.complete())
        {
            if !store_present(&options) {
                return no_store(&options, out);
            }
            let target = open_existing_target(&options.target).await?;
            return verify_with(&target, &options, out).await;
        }

        // R7's store requirement, answered before the source is dialled so a missing store is
        // reported rather than a database error. The writable open below follows it in this
        // process, which is why the check must not open the store itself.
        check_resume_store(existing.as_ref(), &options)?;
        // The source is named before it is dialled and probed before the copy: a run whose
        // `DB_URI` is unset would otherwise resolve to `postgres@localhost:5432/postgres` and
        // copy whatever that happens to hold, and one whose host is down would report the
        // pool's acquire timeout a minute later instead of the database it could not reach.
        let described = describe_source()?;
        // Master only: the copy reads the master and nothing else, so a replica that is down
        // during a cutover must not be able to stop it.
        let source = PostgresBackend::master_only_from_env()
            .await
            .map_err(|error| {
                CliError::Migrate(format!("could not read the source at {described}: {error}"))
            })?;
        probe_source(&source, &described).await?;
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

    // The same premise from the other side: a manifest that counts rows must find them. Asking
    // about the store by its file tells a missing store from a present one, not a store this run
    // wrote from one truncated, or written by something else, that still has a `data.mdb`. The
    // copy would then add the remaining rows to a table that never held the ones the manifest
    // counts, and report success over a store missing them; verify would catch it, but only if
    // someone runs it. One row tells an empty table, and only counted tables are read.
    if let Some(recorded) = &existing {
        for table in MigratedTable::ALL {
            let counted = recorded.get(table).rows;
            if counted == 0 {
                continue;
            }
            let held = target
                .scan_batch(table, None, 1)
                .await
                .map_err(|error| table_failed(table, &error))?;
            if held.is_empty() {
                return Err(CliError::Migrate(format!(
                    "{} counts {counted} rows and the store holds none: the store beside the \
                     manifest is not the one the run wrote to",
                    table.name()
                )));
            }
        }
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
    // Where the copy landed: a target that was redirected or mistyped is visible here rather
    // than as a store the operator cannot find.
    writeln!(
        out,
        "Store: {}",
        fs::canonicalize(store_path(options))
            .unwrap_or_else(|_| store_path(options))
            .display()
    )
    .map_err(write_failed)?;

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

    /// Whether the manifest records that a run did anything: a row written, a cursor moved, or
    /// a table finished. A manifest that records none of that cannot have written a row (R7),
    /// so a fresh store beside it is honest; one that records progress is only meaningful
    /// beside the store the progress went into.
    fn records_progress(&self) -> bool {
        self.tables
            .values()
            .any(|entry| entry.rows != 0 || !entry.after.is_empty() || entry.complete)
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
        sum_words(&mut self.0, words);
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

/// Adds four big-endian words into a 256-bit limb sum, modulo 2^256.
///
/// The manifest documents the checksum as the sum of the row digests modulo 2^256
/// (`docs/rewrite/decisions/0012-pg-to-lmdb-migration.md`). Adding the four words
/// independently is a different number whenever a limb wraps, and an independent checker
/// written from the documentation would compute a checksum this tool calls wrong, so the
/// carry has to cross the word boundary. Limb 3 is the least significant — `to_hex` writes
/// limb 0 first — so the carry runs from index 3 up to 0, and the carry out of the top limb
/// is dropped, which is what makes the result the sum modulo 2^256.
fn sum_words(limbs: &mut [u64; 4], words: &[[u8; 8]]) {
    let mut carry = 0u128;
    for (index, word) in words.iter().enumerate().rev() {
        let sum = u128::from(limbs[index]) + u128::from(u64::from_be_bytes(*word)) + carry;
        limbs[index] = sum as u64;
        carry = sum >> 64;
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
///
/// The file is created exclusively and written 0600, and both halves are load-bearing. The
/// manifest records the last key written per table, and for `invite_codes` that key is the
/// invite code itself - a bearer credential NIP-43 accepts - so the manifest must not be the
/// world-readable copy of it; the store's own files are heed's 0600. Creating exclusively
/// refuses an entry already at the temporary path, which is how a planted symlink would
/// otherwise redirect the write and be renamed into place.
fn write_manifest(target: &Path, manifest: &Manifest) -> Result<(), CliError> {
    let path = manifest_path(target);
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", path.display())))?;

    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(CliError::Migrate(format!(
                "{}: {error}",
                temporary.display()
            )));
        }
    }

    // The rename is the commit point, so it needs both halves of the durability it implies:
    // the bytes on disk before the name moves, and the directory entry durable after it.
    // Without the file sync, a power loss can leave the new name pointing at a truncated
    // manifest; `read_manifest` then refuses it, and the nonempty-target rule refuses to
    // migrate over the store it describes, so the operator's only way forward is a discard.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", temporary.display())))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| CliError::Migrate(format!("{}: {error}", temporary.display())))?;
    drop(file);

    fs::rename(&temporary, &path)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", path.display())))?;
    sync_directory_of(&path)
}

/// Makes a rename inside a directory durable.
///
/// A rename changes the directory, not the file, and an unsynced directory can lose that
/// entry on power loss even though the file's own content was synced.
fn sync_directory_of(path: &Path) -> Result<(), CliError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let directory = fs::File::open(parent)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", parent.display())))?;
    directory
        .sync_all()
        .map_err(|error| CliError::Migrate(format!("{}: {error}", parent.display())))
}

/// The source the run reads, as the setting that named it: `db.internal:5432/nostream (from
/// DB_URI)`. An unconfigured source is refused here, because `from_env` would otherwise fall
/// back to a local server's `postgres` database and copy whatever it holds.
fn describe_source() -> Result<String, CliError> {
    if let Some(uri) = std::env::var("DB_URI")
        .ok()
        .filter(|uri| !uri.trim().is_empty())
    {
        return Ok(format!("{} (from DB_URI)", without_credentials(&uri)));
    }
    match std::env::var("DB_HOST") {
        Ok(host) => Ok(format!(
            "{host}:{port}/{database} (from DB_HOST, DB_NAME)",
            port = std::env::var("DB_PORT").unwrap_or_else(|_| "5432".to_owned()),
            database = std::env::var("DB_NAME").unwrap_or_else(|_| "postgres".to_owned()),
        )),
        Err(_) => Err(CliError::Migrate(
            "no source is configured: set DB_URI (for example \
             postgres://user:pass@host:5432/nostream), or DB_HOST and DB_NAME. Nothing was read."
                .to_owned(),
        )),
    }
}

/// A connection URI with its credentials dropped, so an error can name the source without
/// printing a password - or a role - into a terminal's scrollback or a captured log.
///
/// Three things go: the userinfo, the query string and the fragment. The userinfo because the
/// message exists to name the host and database, and a role is neither; the query because it can
/// carry `?password=`, and matching credential-shaped keys would miss a percent-encoded name.
/// When a permission error is the problem, the server's own message names the role.
fn without_credentials(uri: &str) -> String {
    let Some((scheme, rest)) = uri.split_once("://") else {
        return uri.to_owned();
    };
    let rest = rest.split('?').next().unwrap_or(rest);
    let rest = rest.split('#').next().unwrap_or(rest);
    let rest = rest
        .rsplit_once('@')
        .map_or(rest, |(_userinfo, after)| after);
    format!("{scheme}://{rest}")
}

/// Reads one row before the copy, so an unreachable source is reported as the source it is -
/// named by its setting, host and database - rather than as a pool acquire timeout.
async fn probe_source(source: &PostgresBackend, described: &str) -> Result<(), CliError> {
    let budget = std::env::var("DB_ACQUIRE_CONNECTION_TIMEOUT")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(15));
    match tokio::time::timeout(budget, source.read_batch(MigratedTable::ALL[0], None, 1)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(CliError::Migrate(format!(
            "could not read the source at {described}: {error}"
        ))),
        Err(_) => Err(CliError::Migrate(format!(
            "could not read the source at {described}: no connection within {} s",
            budget.as_secs()
        ))),
    }
}

/// Refuses a target another local user could write to or redirect.
///
/// The copy writes the whole dataset into `<target>/lmdb`, so a group- or world-writable target
/// lets another local user pre-place the store and read what lands in it, and a symlinked target
/// sends the copy somewhere the operator did not name. Both are refused before anything is
/// opened. A target that does not exist yet is left alone: `open_target` creates it under the
/// operator's own umask.
fn refuse_unsafe_target(options: &MigrateOptions) -> Result<(), CliError> {
    for path in [&options.target, &store_path(options)] {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(CliError::Migrate(format!("{}: {error}", path.display())));
            }
        };
        if metadata.file_type().is_symlink() {
            return Err(CliError::Migrate(format!(
                "{} is a symlink: the target must be the directory the copy lands in",
                path.display()
            )));
        }
        if !metadata.is_dir() {
            return Err(CliError::Migrate(format!(
                "{} is not a directory: --target takes the store root, and the environment is \
                 created under it",
                path.display()
            )));
        }
        let mode = metadata.permissions().mode();
        if mode & 0o022 != 0 {
            return Err(CliError::Migrate(format!(
                "{} is writable by group or other ({:04o}): the target must be a directory only \
                 its owner can write to",
                path.display(),
                mode & 0o7777
            )));
        }
    }
    Ok(())
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
    nostream_storage::backend::store_dir(&options.target)
}

/// Whether the target already holds an LMDB environment, asked the way R8 asks it: `<target>/
/// lmdb/data.mdb` is a file. A directory alone is not a store, and neither is a lock file.
fn store_present(options: &MigrateOptions) -> bool {
    nostream_storage::backend::store_exists(&options.target)
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

/// The store requirement R7 puts on a resume.
///
/// A manifest that records progress is only meaningful beside the store the progress went into:
/// the writable open that follows this check creates a missing store, and the copy would then
/// skip the tables already counted and the rows already summed, exiting 0 against a store
/// missing every row the manifest claims.
///
/// The question is asked by the store's file and not by opening it. A read-only open registers
/// the environment with heed process-wide, and the writable open of the same path in the same
/// process then answers `BadOpenOptions` — so a probe here would make a resume fail exactly
/// when its store is present. `tests::the_resume_check_leaves_the_store_openable` drives both
/// steps for that reason.
fn check_resume_store(
    existing: Option<&Manifest>,
    options: &MigrateOptions,
) -> Result<(), CliError> {
    if existing.is_some_and(|manifest| manifest.records_progress()) && !store_present(options) {
        return Err(CliError::Migrate(format!(
            "No store at {}: the manifest records progress, so a re-run resumes once the store is \
             back; delete {} to start a new copy",
            store_path(options).display(),
            manifest_path(&options.target).display()
        )));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The resume path's store check and the writable open that follows it run in one process,
    /// so the check must not open the store: heed keeps an environment registered for the life
    /// of the process, and a read-only open there makes the writable one answer
    /// `BadOpenOptions` — a resume failing exactly when its store is present. Nothing but both
    /// steps together can see it.
    #[tokio::test]
    #[allow(clippy::expect_used, clippy::unwrap_used)]
    async fn the_resume_check_leaves_the_store_openable() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        let mut manifest = Manifest::fresh();
        manifest.entry(MigratedTable::Events).rows = 1;
        let options = MigrateOptions {
            target: directory.path().to_path_buf(),
            batch_size: 1_000,
            verify: false,
        };

        check_resume_store(Some(&manifest), &options)
            .expect("the store the manifest needs is there");
        open_target(&options.target)
            .await
            .expect("the writable open after the check succeeds");
    }

    /// The documented checksum is the sum modulo 2^256, so a wrap in the least significant
    /// limb carries into the one above it. Adding the four words independently — which is
    /// what this replaced — gives a different number whenever a limb wraps, and a checker
    /// written from the documentation would then disagree with the tool.
    #[test]
    fn a_wrapped_limb_carries_into_the_next_one() {
        let mut limbs = [0u64, 0, 0, u64::MAX];
        let words = [[0u8; 8], [0u8; 8], [0u8; 8], 1u64.to_be_bytes()];

        sum_words(&mut limbs, &words);

        assert_eq!(
            limbs,
            [0, 0, 1, 0],
            "the carry left the least significant limb"
        );
    }

    /// The carry out of the most significant limb is dropped, which is the `modulo 2^256` in
    /// the documented definition: four saturated limbs plus one sum to zero, not to a carry.
    #[test]
    fn the_carry_out_of_the_top_limb_is_dropped() {
        let mut limbs = [u64::MAX, u64::MAX, u64::MAX, u64::MAX];
        let words = [[0u8; 8], [0u8; 8], [0u8; 8], 1u64.to_be_bytes()];

        sum_words(&mut limbs, &words);

        assert_eq!(limbs, [0, 0, 0, 0], "the sum wraps at 2^256");
    }

    /// Limb 0 is the most significant, because `to_hex` writes it first; a word added into
    /// it must land there and not at the other end.
    #[test]
    fn the_first_word_is_the_most_significant_limb() {
        let mut limbs = [0u64; 4];
        let words = [1u64.to_be_bytes(), [0u8; 8], [0u8; 8], [0u8; 8]];

        sum_words(&mut limbs, &words);

        assert_eq!(limbs, [1, 0, 0, 0]);
    }
}
