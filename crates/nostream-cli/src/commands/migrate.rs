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
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
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
#[cfg(unix)]
pub fn run(options: MigrateOptions, out: &mut dyn Write) -> Result<CommandOutput, CliError> {
    run_with(options, out, || {})
}

/// The command over a step injected between the target's pin and the root derived from it.
///
/// Nothing in the command renames its target, so production passes an empty closure; it is how a
/// test reaches the interval between the pin and the store's open, which no request the command
/// makes can block on — the same split `refuse_unsafe_target_for`'s `caller` makes for the uid
/// branch.
#[cfg(unix)]
fn run_with(
    options: MigrateOptions,
    out: &mut dyn Write,
    mut after_pin: impl FnMut(),
) -> Result<CommandOutput, CliError> {
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
            if read_manifest(&options.target, &options.target)?.is_none() {
                return no_manifest(&options.target, out);
            }
            // The pin is taken after both answers, so a target that is not there is refused by
            // the pre-check's line rather than by a failed open; from here the store and the
            // manifest are read through the descriptor.
            let pin = TargetPin::pin(&options.target)?;
            after_pin();
            let root = pin.root();
            let target = open_existing_target(&root, &options.target).await?;
            return verify_with(&target, &root, &options, out).await;
        }

        let existing = read_manifest(&options.target, &options.target)?;

        // A complete manifest is verified rather than copied, and the source is never opened:
        // a finished migration must not need Postgres to still be reachable.
        if existing
            .as_ref()
            .is_some_and(|manifest| manifest.complete())
        {
            if !store_present(&options) {
                return no_store(&options, out);
            }
            let pin = TargetPin::pin(&options.target)?;
            after_pin();
            let root = pin.root();
            let target = open_existing_target(&root, &options.target).await?;
            return verify_with(&target, &root, &options, out).await;
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
        // One direct attempt first, bounded: the pool retries a refused socket until its
        // acquire timeout, so only a direct connection answers with the reason. Then the
        // master-only backend, because the copy reads the master and nothing else and a
        // replica that is down during a cutover must not stop it.
        PostgresBackend::probe_master_from_env(probe_budget())
            .await
            .map_err(|error| {
                CliError::Migrate(format!("could not read the source at {described}: {error}"))
            })?;
        let source = PostgresBackend::master_only_from_env().map_err(|error| {
            CliError::Migrate(format!("could not read the source at {described}: {error}"))
        })?;
        let pin = create_target(&options)?;
        after_pin();
        let root = pin.root();
        let target = open_target(&root, &options.target).await?;
        pin.verify(&options.target)?;
        migrate_with(&source, &target, &root, &options, out).await
    })
}

/// The copy over an injected source, target and writer, which is how the whole run is tested
/// without a process and without a database.
///
/// Every batch's rows are written to the store and then folded into the manifest, which is
/// replaced after each batch; a batch that fails leaves the previous batch's `after`, `rows` and
/// `checksum` in place, so the next run resumes at the refused row.
///
/// `root` is the path the store and the manifest are read and written through: the target's own
/// descriptor spelling where procfs answers, and the operator's path otherwise.
pub async fn migrate_with(
    source: &dyn MigrationSource,
    target: &dyn MigrationTarget,
    root: &Path,
    options: &MigrateOptions,
    out: &mut dyn Write,
) -> Result<CommandOutput, CliError> {
    refuse_zero_batch(options)?;
    let existing = read_manifest(root, &options.target)?;
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
        write_manifest(root, &options.target, &manifest)?;
    }

    if manifest.complete() {
        return verify_with(target, root, options, out).await;
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
            write_manifest(root, &options.target, &manifest)?;

            if complete {
                break;
            }
        }
    }

    let ms = u64::try_from(measured.unwrap_or_default().as_millis()).unwrap_or(u64::MAX);
    let rate = events.saturating_mul(1_000) / ms.max(1);
    writeln!(out, "Migrated {total} rows in {ms} ms").map_err(write_failed)?;
    writeln!(out, "Events throughput: {rate} events/s").map_err(write_failed)?;
    // Where the copy landed, resolved through the root it wrote through: a target that was
    // redirected or mistyped is visible here rather than as a store the operator cannot find.
    writeln!(
        out,
        "Store: {}",
        fs::canonicalize(store_path(root))
            .unwrap_or_else(|_| store_path(root))
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
///
/// `root` is the path the store and the manifest are read through: the target's own descriptor
/// spelling where procfs answers, and the operator's path otherwise.
pub async fn verify_with(
    target: &dyn MigrationTarget,
    root: &Path,
    options: &MigrateOptions,
    out: &mut dyn Write,
) -> Result<CommandOutput, CliError> {
    refuse_zero_batch(options)?;
    let Some(manifest) = read_manifest(root, &options.target)? else {
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

/// A message about `root` rewritten to name the target the operator typed.
///
/// The root is the pin's descriptor spelling where procfs answers, and a descriptor number dies
/// with this process and means nothing in the operator's shell: every message the command builds
/// from a root-joined path passes through here first. Where the root is the target itself — no
/// procfs, or a caller that opens the operator's own path — this replaces the text with itself.
fn operator_message(message: String, root: &Path, target: &Path) -> String {
    message.replace(&root.display().to_string(), &target.display().to_string())
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

/// The manifest at `root`, or `None` when there is none.
///
/// `target` is the path the operator named: the root's spelling is translated back to it in every
/// message here, because a descriptor number means nothing in their shell.
fn read_manifest(root: &Path, target: &Path) -> Result<Option<Manifest>, CliError> {
    let shown = |message: String| operator_message(message, root, target);
    let path = manifest_path(root);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CliError::Migrate(shown(format!(
                "{}: {error}",
                path.display()
            ))));
        }
    };
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|error| CliError::Migrate(shown(format!("{}: {error}", path.display()))))?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(CliError::Migrate(shown(format!(
            "{}: manifest format {} is not supported; this tool reads and writes {MANIFEST_FORMAT}",
            path.display(),
            manifest.format
        ))));
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
        return Err(CliError::Migrate(shown(format!(
            "{}: the manifest does not name this tool's nine tables (missing: {}; unknown: {})",
            path.display(),
            named_list(&missing),
            named_list(&unknown)
        ))));
    }
    if manifest.not_migrated != MigratedTable::NOT_MIGRATED {
        let named: Vec<&str> = manifest.not_migrated.iter().map(String::as_str).collect();
        return Err(CliError::Migrate(shown(format!(
            "{}: the manifest's not_migrated is not the two tables this tool leaves alone (it \
             names: {})",
            path.display(),
            named_list(&named)
        ))));
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
///
/// `target` is the path the operator named: the root's spelling is translated back to it in every
/// message here.
fn write_manifest(root: &Path, target: &Path, manifest: &Manifest) -> Result<(), CliError> {
    let shown = |message: String| operator_message(message, root, target);
    let path = manifest_path(root);
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| CliError::Migrate(shown(format!("{}: {error}", path.display()))))?;

    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(CliError::Migrate(shown(format!(
                "{}: {error}",
                temporary.display()
            ))));
        }
    }

    // The rename is the commit point, so it needs both halves of the durability it implies:
    // the bytes on disk before the name moves, and the directory entry durable after it.
    // Without the file sync, a power loss can leave the new name pointing at a truncated
    // manifest; `read_manifest` then refuses it, and the nonempty-target rule refuses to
    // migrate over the store it describes, so the operator's only way forward is a discard.
    let mut open_options = fs::OpenOptions::new();
    open_options.write(true).create_new(true);
    #[cfg(unix)]
    open_options.mode(0o600);
    let mut file = open_options
        .open(&temporary)
        .map_err(|error| CliError::Migrate(shown(format!("{}: {error}", temporary.display()))))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| CliError::Migrate(shown(format!("{}: {error}", temporary.display()))))?;
    drop(file);

    fs::rename(&temporary, &path)
        .map_err(|error| CliError::Migrate(shown(format!("{}: {error}", path.display()))))?;
    sync_directory_of(&path, root, target)
}

/// Makes a rename inside a directory durable.
///
/// A rename changes the directory, not the file, and an unsynced directory can lose that
/// entry on power loss even though the file's own content was synced.
fn sync_directory_of(path: &Path, root: &Path, target: &Path) -> Result<(), CliError> {
    let shown = |message: String| operator_message(message, root, target);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let directory = fs::File::open(parent)
        .map_err(|error| CliError::Migrate(shown(format!("{}: {error}", parent.display()))))?;
    directory
        .sync_all()
        .map_err(|error| CliError::Migrate(shown(format!("{}: {error}", parent.display()))))
}

/// The source the run reads, as the setting that named it: `db.internal:5432/nostream (from
/// DB_URI)`. An unconfigured source is refused here, because `from_env` would otherwise fall
/// back to a local server's `postgres` database and copy whatever it holds.
fn describe_source() -> Result<String, CliError> {
    if let Some(uri) = std::env::var("DB_URI")
        .ok()
        .filter(|uri| !uri.trim().is_empty())
    {
        // sqlx parses a schemeless string as a URL with no base: the opaque path becomes the
        // database name and the host falls back to localhost. The copy would dial the wrong
        // server, and a failure echoes the database name - which for a libpq-style string is
        // the credentials. The shape is refused before anything is dialled.
        if !is_url_with_host(&uri) {
            // The value is not echoed: a libpq keyword string (`host=… password=…`) has no
            // userinfo to strip, so any echo of what was set would print it.
            return Err(CliError::Migrate(
                "DB_URI is not a URL with a host: use postgres://user:password@host:5432/database, \
                 or postgres:///?host=/var/run/postgresql for a socket"
                    .into(),
            ));
        }
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

/// Whether `uri` is a Postgres URL with a host to dial.
///
/// The gate exists because sqlx reads a string with no base as a URL whose opaque path is the
/// database name and whose host is `localhost`: the copy would dial a server nobody named and
/// then echo the string back in the failure. So this refuses three shapes sqlx happily dials -
/// `postgres://`, `postgres:////` and `postgres:///db`, all `localhost` to sqlx - because a
/// cutover that guesses which server to copy from is worse than one that stops and says so.
/// That divergence is deliberate and pinned by a test.
///
/// Everything else a Postgres URL can be is left alone: the `postgres` and `postgresql` schemes in
/// either case, an authority with userinfo, an IPv6 literal, a port, a path, a query; and the
/// socket forms `postgres:///?host=/var/run/postgresql` and `postgres:///?hostaddr=127.0.0.1`,
/// whose authority is empty by design. A `?` inside a `#` fragment is not a query, because sqlx
/// ignores the fragment - `postgres://#?host=/sock` has no host at all.
fn is_url_with_host(uri: &str) -> bool {
    let Some((scheme, rest)) = uri.split_once("://") else {
        return false;
    };
    // Only a Postgres scheme. A libpq keyword string can contain `://` by accident
    // (`password=ab://cd`), and sqlx would read `password=ab` as the scheme and `cd` as the host.
    if !scheme.eq_ignore_ascii_case("postgres") && !scheme.eq_ignore_ascii_case("postgresql") {
        return false;
    }
    // Everything after `#` is a fragment: sqlx ignores it, so a `?` inside one is not a query.
    let rest = rest.split('#').next().unwrap_or_default();
    // The authority ends at the first `/` or `?`; everything after it is path and query.
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_userinfo, host)| host);
    // `user@:5432` is an empty host with a port: sqlx refuses it, and so does this.
    let host = if host.starts_with('[') {
        host.split_once(']').map_or("", |(inner, _rest)| inner)
    } else {
        host.split(':').next().unwrap_or_default()
    };
    if !host.is_empty() {
        return true;
    }
    // The socket forms carry no authority: the host is a query parameter.
    rest.split_once('?').is_some_and(|(_path, query)| {
        query.split('&').any(|pair| {
            matches!(
                pair.split('=').next().unwrap_or_default(),
                "host" | "hostaddr"
            )
        })
    })
}

/// A connection URI with its credentials dropped, so an error can name the source without
/// printing a password - or a role - into a terminal's scrollback or a captured log.
///
/// The query string and the fragment go first, because either can carry `?password=` and
/// neither is part of what identifies the source. Then everything up to the last `@`, which is
/// the userinfo in a URL and the credentials in a schemeless string of the shape libpq accepts
/// (`postgres:alice:secret@host:5432/db`) - the scheme test comes after both, so a string with
/// no `://` is redacted too. Matching credential-shaped keys instead would miss a
/// percent-encoded name, and when a permission error is the problem the server's own message
/// names the role.
fn without_credentials(uri: &str) -> String {
    let uri = uri.split('?').next().unwrap_or(uri);
    let uri = uri.split('#').next().unwrap_or(uri);
    let (scheme, rest) = match uri.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, uri),
    };
    let rest = rest
        .rsplit_once('@')
        .map_or(rest, |(_userinfo, after)| after);
    match scheme {
        Some(scheme) => format!("{scheme}://{rest}"),
        None => rest.to_owned(),
    }
}

/// The wait the source's first connection gets.
///
/// `DB_ACQUIRE_CONNECTION_TIMEOUT` is what the shipped `.env.example` sets, and a probe that
/// inherited it would be a minute of silence on a mistyped host: the budget is that setting
/// capped at `MIGRATION_CONNECT_CAP_MS`, so the ceiling holds whatever the pool is told.
fn probe_budget() -> Duration {
    let cap = Duration::from_millis(nostream_storage::postgres::MIGRATION_CONNECT_CAP_MS);
    std::env::var("DB_ACQUIRE_CONNECTION_TIMEOUT")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(cap)
        .min(cap)
}

/// Refuses a target another local user could write to or redirect.
///
/// The copy writes the whole dataset into `<target>/lmdb`, so a group- or world-writable target
/// lets another local user pre-place the store and read what lands in it, and a symlinked target
/// sends the copy somewhere the operator did not name. Both are refused before anything is
/// opened. A target that does not exist yet cannot be judged here, so `create_target` creates it
/// before the store opens and runs this check again over what is then on disk.
#[cfg(unix)]
fn refuse_unsafe_target(options: &MigrateOptions) -> Result<(), CliError> {
    refuse_unsafe_target_for(options, effective_uid())
}

/// The effective uid of this process, from `/proc/self/status`.
///
/// `std::fs` exposes a file's owner but not the caller's, and reading it here costs no
/// dependency: this crate runs on Linux, where the kernel publishes it in one line.
#[cfg(unix)]
fn effective_uid() -> Option<u32> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("Uid:"))?;
    line.split_whitespace().nth(2)?.parse().ok()
}

#[cfg(unix)]
fn refuse_unsafe_target_for(options: &MigrateOptions, caller: Option<u32>) -> Result<(), CliError> {
    for path in [&options.target, &store_path(&options.target)] {
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
        // The owner matters as much as the mode. A directory another user owns can be
        // replaced by its owner between this check and the open, whatever its bits say, so a
        // copy running as root over a predictable path in a shared directory would follow the
        // replacement into files the other user can read. `None` means /proc could not say, and
        // then the mode check is what stands.
        if let Some(caller) = caller
            && metadata.uid() != caller
        {
            return Err(CliError::Migrate(format!(
                "{} is owned by uid {}, not by the user running the copy ({caller}): the target \
                 must be a directory that user owns",
                path.display(),
                metadata.uid()
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
    // The directory that holds the target decides whether the target itself can be replaced.
    // Write permission on a directory is what allows an entry in it to be renamed away and
    // another put in its place, and it takes no ownership of the entry to do it, so the mode is
    // asked first; the holder's own owner is asked after it, since its owner needs no bits.
    refuse_swappable_ancestry(&options.target, caller)?;

    // The data file itself, which `is_file()` and LMDB both follow: a link there would let the
    // copy read or write through it, and heed creates `lock.mdb` beside whatever it resolves to.
    // A predicate over the file's own metadata is the only way to see that.
    let store = nostream_storage::backend::store_file(&options.target);
    match fs::symlink_metadata(&store) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(CliError::Migrate(format!(
                    "{} is a symlink: the store's data file must be a regular file",
                    store.display()
                )));
            }
            if !metadata.is_file() {
                return Err(CliError::Migrate(format!(
                    "{} is not a regular file: the store's data file must be one",
                    store.display()
                )));
            }
            if let Some(caller) = caller
                && metadata.uid() != caller
            {
                return Err(CliError::Migrate(format!(
                    "{} is owned by uid {}, not by the user running the copy ({caller})",
                    store.display(),
                    metadata.uid()
                )));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(CliError::Migrate(format!("{}: {error}", store.display())));
        }
    }

    Ok(())
}

/// Refuses an ancestor another user could use to replace the target.
///
/// Renaming an entry needs write permission on the directory that holds it, and no ownership of
/// the entry itself, so a group- or world-writable ancestor lets another user move this target
/// aside and put their own there before the store opens. The sticky bit is the exception that
/// makes `/tmp` usable: it refuses the rename of an entry its writer does not own.
///
/// Ownership is the other half, and the mode cannot see it: the owner of an ancestor can rename
/// its entries whatever the bits say, so `--target /home/alice/store` run as root is swappable by
/// alice even though `/home/alice` is `0755`. An ancestor owned by neither the caller nor root is
/// refused outright. The sticky bit is no exemption here: it restrains other users, not the
/// directory's own owner, who may still rename an entry inside it — `/tmp` is safe because root
/// owns it, not because it is sticky.
#[cfg(unix)]
fn refuse_swappable_ancestry(target: &Path, caller: Option<u32>) -> Result<(), CliError> {
    let mut path = match target.parent() {
        Some(parent) if parent.as_os_str().is_empty() => PathBuf::from("."),
        Some(parent) => parent.to_path_buf(),
        None => return Ok(()),
    };

    loop {
        // `metadata` follows, not `symlink_metadata`: the question is the directory the kernel
        // would use, and a linked ancestor stands in for the one it points at.
        match fs::metadata(&path) {
            Ok(metadata) => {
                let mode = metadata.permissions().mode();
                let sticky = mode & 0o1000 != 0;
                if mode & 0o022 != 0 && !sticky {
                    return Err(CliError::Migrate(format!(
                        "{} is writable by group or other ({:04o}) and has no sticky bit: another \
                         user could replace {} before the store opens. Put the target under a \
                         directory only its owner can write to, or under one with the sticky bit",
                        path.display(),
                        mode & 0o7777,
                        target.display()
                    )));
                }
                // The mode's blind spot: an ancestor's owner renames its entries whatever the
                // bits say, and root is the caller often enough that `/home/<other>` is reached
                // this way. The sticky bit does not help — it restrains other users, not the
                // directory's owner — so ownership is asked on its own.
                if let Some(caller) = caller
                    && metadata.uid() != caller
                    && metadata.uid() != 0
                {
                    return Err(CliError::Migrate(format!(
                        "{} is owned by uid {}, neither the user running the copy ({caller}) nor \
                         root, so its owner could replace {} before the store opens. Put the \
                         target under a directory the caller or root owns",
                        path.display(),
                        metadata.uid(),
                        target.display()
                    )));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CliError::Migrate(format!("{}: {error}", path.display())));
            }
        }

        match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => path = parent.to_path_buf(),
            _ => return Ok(()),
        }
    }
}

/// The root `path` is opened through: the descriptor's own procfs spelling where procfs
/// answers, and `path` unchanged where it does not.
///
/// The answer is a parameter rather than a probe, so a test can drive the branch a host without
/// `/proc` would take — the same split `refuse_unsafe_target_for` makes for the caller's uid.
#[cfg(unix)]
fn root_for(handle: &fs::File, path: &Path, procfs: bool) -> PathBuf {
    if procfs {
        PathBuf::from(format!("/proc/self/fd/{}", handle.as_raw_fd()))
    } else {
        path.to_path_buf()
    }
}

/// A handle and device/inode pin on the target directory, taken before the store opens.
///
/// Holding the handle keeps the directory inode alive and names it through `root`, so the store
/// and every manifest write after the pin resolve to the inode the security checks judged,
/// however the operator's path is renamed afterwards. That narrows the TOCTOU window between
/// target creation and store open and does not close it: heed canonicalises the spelling before
/// `mdb_env_open` (`heed-0.20.5/src/env.rs:239,305`), so the mapping itself still resolves a
/// name. `verify` is the post-open cross-check of the operator's path, and the only check where
/// procfs is absent.
#[cfg(unix)]
#[derive(Debug)]
struct TargetPin {
    handle: fs::File,
    /// The path the pin was taken at, which is the root where procfs does not answer.
    path: PathBuf,
    dev: u64,
    ino: u64,
}

#[cfg(unix)]
impl TargetPin {
    fn pin(path: &Path) -> Result<Self, CliError> {
        let file = fs::File::open(path)
            .map_err(|error| CliError::Migrate(format!("{}: {error}", path.display())))?;
        let metadata = file
            .metadata()
            .map_err(|error| CliError::Migrate(format!("{}: {error}", path.display())))?;
        Ok(Self {
            handle: file,
            path: path.to_path_buf(),
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }

    /// The root the store and the manifest are opened through: the pin's own descriptor where
    /// procfs answers, and the path the pin was taken at otherwise.
    fn root(&self) -> PathBuf {
        root_for(
            &self.handle,
            &self.path,
            Path::new("/proc/self/fd").is_dir(),
        )
    }

    fn verify(&self, path: &Path) -> Result<(), CliError> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| CliError::Migrate(format!("{}: {error}", path.display())))?;
        if metadata.dev() != self.dev || metadata.ino() != self.ino {
            return Err(CliError::Migrate(format!(
                "{} was replaced between check and open: expected inode {} on device {}, found inode {} on device {}",
                path.display(),
                self.ino,
                self.dev,
                metadata.ino(),
                metadata.dev()
            )));
        }
        Ok(())
    }
}

#[cfg(not(unix))]
#[derive(Debug)]
struct TargetPin {
    path: PathBuf,
}

#[cfg(not(unix))]
impl TargetPin {
    fn pin(path: &Path) -> Result<Self, CliError> {
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    fn root(&self) -> PathBuf {
        self.path.clone()
    }

    fn verify(&self, _path: &Path) -> Result<(), CliError> {
        Ok(())
    }
}

/// Creates the target when it is missing, judges what is on disk, and pins the directory
/// handle the store is opened through. The pin narrows, and does not close, the TOCTOU window
/// between this check and the store's open.
#[cfg(unix)]
fn create_target(options: &MigrateOptions) -> Result<TargetPin, CliError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&options.target)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", options.target.display())))?;

    refuse_unsafe_target(options)?;
    TargetPin::pin(&options.target)
}

#[cfg(not(unix))]
fn create_target(options: &MigrateOptions) -> Result<TargetPin, CliError> {
    fs::create_dir_all(&options.target)
        .map_err(|error| CliError::Migrate(format!("{}: {error}", options.target.display())))?;

    refuse_unsafe_target(options)?;
    TargetPin::pin(&options.target)
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
    writeln!(
        out,
        "No store at {}: a re-run resumes once the store is back. To start over, use a fresh \
         --target, or remove {} and the store together",
        store_path(&options.target).display(),
        manifest_path(&options.target).display()
    )
    .map_err(write_failed)?;
    Ok(CommandOutput {
        lines: Vec::new(),
        exit_code: 1,
    })
}

/// The store's directory under a root: the environment `LmdbBackend::open` would create.
fn store_path(root: &Path) -> PathBuf {
    nostream_storage::backend::store_dir(root)
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
             back. To start over, use a fresh --target, or remove {} and the store together",
            store_path(&options.target).display(),
            manifest_path(&options.target).display()
        )));
    }
    Ok(())
}

/// Opens the store a copy writes, creating it when it is not there.
///
/// A failure names `target`, the path the operator typed: the open went through `root`, whose
/// spelling means nothing outside this process.
async fn open_target(root: &Path, target: &Path) -> Result<LmdbBackend, CliError> {
    LmdbBackend::open(root)
        .await
        .map_err(|error| CliError::Migrate(operator_message(error.to_string(), root, target)))
}

/// Opens the store a verify reads, read-only and creating nothing (R8).
async fn open_existing_target(root: &Path, target: &Path) -> Result<LmdbBackend, CliError> {
    LmdbBackend::open_existing(root)
        .await
        .map_err(|error| CliError::Migrate(operator_message(error.to_string(), root, target)))
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

    /// A link where the data file belongs is followed by `is_file()` and by LMDB both, so the
    /// copy would read or write through it and heed would put `lock.mdb` beside the link's
    /// target. The predicate over the file's own metadata is what AC18 asks for.
    #[cfg(unix)]
    #[test]
    #[allow(clippy::expect_used)]
    fn a_symlinked_data_file_is_refused() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let store = directory.path().join("lmdb");
        fs::create_dir(&store).expect("the store directory is made");
        let elsewhere = directory.path().join("elsewhere");
        fs::write(&elsewhere, b"not a store").expect("the target file is written");
        std::os::unix::fs::symlink(&elsewhere, store.join("data.mdb"))
            .expect("the link is planted");

        let options = MigrateOptions {
            target: directory.path().to_path_buf(),
            batch_size: 1_000,
            verify: true,
        };
        let error = refuse_unsafe_target_for(&options, effective_uid())
            .expect_err("a linked data file is refused");
        assert!(error.to_string().contains("is a symlink"), "{error}");
    }

    /// The directory's owner decides whether it can be swapped for another one, and it is
    /// checked against the caller rather than the mode. Measured as if a different uid were
    /// running, because a directory this process owns cannot be made to belong to another user
    /// without root.
    #[cfg(unix)]
    #[test]
    #[allow(clippy::expect_used)]
    fn a_target_owned_by_another_user_is_refused() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let options = MigrateOptions {
            target: directory.path().to_path_buf(),
            batch_size: 1_000,
            verify: false,
        };
        // Not uid 0 by assumption: a suite running as root creates a root-owned tempdir, and
        // the refusal then has nothing to refuse.
        let owner = std::fs::symlink_metadata(directory.path())
            .expect("the directory's metadata")
            .uid();
        let other = if owner == 0 { 1 } else { 0 };
        let error = refuse_unsafe_target_for(&options, Some(other))
            .expect_err("a uid that does not own this directory is refused");
        assert!(error.to_string().contains("is owned by uid"), "{error}");
        assert!(
            refuse_unsafe_target_for(&options, effective_uid()).is_ok(),
            "the user who owns it is allowed, and /proc names them"
        );
    }

    /// The directory that holds the target decides whether the target can be replaced, and it
    /// needs no ownership of the target to do it: a rename takes write permission on the holder.
    /// Without the sticky bit that permission is refused; `/tmp` is exactly this mode plus the
    /// sticky bit, which is why the bit, and not the mode alone, is the question.
    #[cfg(unix)]
    #[test]
    #[allow(clippy::expect_used)]
    fn a_target_under_a_swappable_directory_is_refused() {
        let temporary = tempfile::tempdir().expect("a temporary directory");
        let shared = temporary.path().join("shared");
        fs::create_dir(&shared).expect("the shared directory is made");
        let options = MigrateOptions {
            target: shared.join("target"),
            batch_size: 1_000,
            verify: false,
        };

        fs::set_permissions(&shared, fs::Permissions::from_mode(0o777))
            .expect("the shared directory is opened");
        let error = refuse_unsafe_target_for(&options, effective_uid())
            .expect_err("a target a group or other user can swap is refused");
        assert!(error.to_string().contains("no sticky bit"), "{error}");

        fs::set_permissions(&shared, fs::Permissions::from_mode(0o1777))
            .expect("the sticky bit is set");
        assert!(
            refuse_unsafe_target_for(&options, effective_uid()).is_ok(),
            "a sticky holder is the shape /tmp has, and is allowed"
        );
    }

    /// The mode's blind spot: an ancestor can be `0755` and still be another user's to reorder,
    /// because its owner needs no write bits to rename an entry inside it. `--target
    /// /home/alice/store` run as root is the shape — every ancestor passes the mode check and
    /// alice can still move the target aside. The sticky bit is not an exemption for the same
    /// reason: it restrains other users, not the stholder's own owner. Measured as if a different
    /// uid were running, since a directory this process owns cannot be made to belong to another
    /// user without root.
    #[cfg(unix)]
    #[test]
    #[allow(clippy::expect_used)]
    fn a_target_under_an_ancestor_another_user_owns_is_refused() {
        let temporary = tempfile::tempdir().expect("a temporary directory");
        let home = temporary.path().join("home");
        fs::create_dir(&home).expect("the ancestor is made");
        fs::set_permissions(&home, fs::Permissions::from_mode(0o755))
            .expect("the ancestor is left as a home directory is");
        let options = MigrateOptions {
            target: home.join("target"),
            batch_size: 1_000,
            verify: false,
        };

        let owner = std::fs::symlink_metadata(&home)
            .expect("the ancestor's metadata")
            .uid();
        if owner == 0 {
            // Running as root: every ancestor this test can make is root's own, and root is
            // exempt by rule, so there is no foreign owner to measure against.
            return;
        }
        // A uid that owns none of these ancestors and is not root, so the refusal is the
        // ancestor's ownership rather than anything about the target.
        let other = 0;
        let error = refuse_unsafe_target_for(&options, Some(other))
            .expect_err("an ancestor owned by neither the caller nor root is refused");
        assert!(
            error
                .to_string()
                .contains("neither the user running the copy"),
            "{error}"
        );

        // The sticky bit is not an exemption: a sticky directory restrains other users, not its
        // own owner, who can still rename the target out of it.
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o1755))
            .expect("the temporary directory is made sticky");
        fs::set_permissions(&home, fs::Permissions::from_mode(0o1755))
            .expect("the ancestor is made sticky");
        let error = refuse_unsafe_target_for(&options, Some(other))
            .expect_err("a sticky ancestor owned by another user is still refused");
        assert!(
            error
                .to_string()
                .contains("neither the user running the copy"),
            "{error}"
        );
    }

    /// The check that runs before the source is dialled can only judge what exists, so the
    /// target is created and then judged. Both halves are needed: the creation gives the second
    /// check something to see, and the second check is what refuses a directory another user
    /// planted while the source was being probed.
    #[cfg(unix)]
    #[test]
    #[allow(clippy::expect_used)]
    fn a_missing_target_is_created_and_then_judged() {
        let temporary = tempfile::tempdir().expect("a temporary directory");
        let target = temporary.path().join("nested").join("target");
        let options = MigrateOptions {
            target: target.clone(),
            batch_size: 1_000,
            verify: false,
        };

        create_target(&options).expect("a missing target is created");

        let metadata = fs::symlink_metadata(&target).expect("the target exists");
        assert!(metadata.is_dir(), "the target is a directory");
        assert_eq!(
            metadata.permissions().mode() & 0o777,
            0o700,
            "the target is private to its owner, whatever the umask says"
        );
        assert_eq!(
            Some(metadata.uid()),
            effective_uid(),
            "and it belongs to the user who ran the copy"
        );
    }

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
        open_target(&options.target, &options.target)
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

    /// A target swapped between the pre-open check and store open has a different inode or device;
    /// `TargetPin::verify` detects the swap and refuses it.
    #[test]
    #[cfg(unix)]
    #[allow(clippy::expect_used)]
    fn a_target_swapped_between_check_and_open_is_refused() {
        let temporary = tempfile::tempdir().expect("a temporary directory");
        let target = temporary.path().join("target");
        fs::create_dir(&target).expect("target is created");

        let pin = TargetPin::pin(&target).expect("target is pinned");

        // Swap the target directory with a newly created one (different inode)
        let swapped = temporary.path().join("target_swapped");
        fs::create_dir(&swapped).expect("swapped is created");
        fs::remove_dir(&target).expect("original target removed");
        fs::rename(&swapped, &target).expect("swapped renamed to target");

        let error = pin
            .verify(&target)
            .expect_err("a target replaced between check and open must be refused");
        assert!(
            error
                .to_string()
                .contains("replaced between check and open"),
            "{error}"
        );
    }

    /// A host with procfs names the pinned directory by its descriptor, and one without it has
    /// nothing but the path: both halves are the `root_for` branch, and the third assertion is
    /// the wiring from the real probe to the helper on a host where it answers.
    #[test]
    #[cfg(unix)]
    #[allow(clippy::expect_used)]
    fn the_root_is_the_descriptor_when_procfs_answers_and_the_path_otherwise() {
        let temporary = tempfile::tempdir().expect("a temporary directory");
        let target = temporary.path().join("target");
        fs::create_dir(&target).expect("the target is created");
        let handle = fs::File::open(&target).expect("the target is opened");

        assert_eq!(
            root_for(&handle, &target, true),
            PathBuf::from(format!("/proc/self/fd/{}", handle.as_raw_fd())),
            "the descriptor branch names the handle's own number"
        );
        assert_eq!(
            root_for(&handle, &target, false),
            target,
            "without procfs the operator's path is the root, unchanged"
        );

        if Path::new("/proc/self/fd").is_dir() {
            let pin = TargetPin::pin(&target).expect("the target is pinned");
            assert_eq!(
                pin.root(),
                PathBuf::from(format!("/proc/self/fd/{}", pin.handle.as_raw_fd())),
                "the pin's root is its own descriptor"
            );
        }
    }

    /// The swap this job exists for: the pin is taken, the target is renamed away through its
    /// parent and a fresh directory takes its name, and the store is then opened through the
    /// descriptor. The store lands in the directory the pin holds whatever the operator's path
    /// now names, and `verify` refuses the path that no longer denotes it.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[allow(clippy::expect_used)]
    async fn a_target_swapped_after_the_pin_keeps_the_store_in_the_pinned_directory() {
        let temporary = tempfile::tempdir().expect("a temporary directory");
        let target = temporary.path().join("target");
        fs::create_dir(&target).expect("the target is created");
        let options = MigrateOptions {
            target: target.clone(),
            batch_size: 1_000,
            verify: false,
        };
        let pin = create_target(&options).expect("the target is pinned");

        let moved = temporary.path().join("moved");
        fs::rename(&target, &moved).expect("the target is renamed away");
        fs::create_dir(&target).expect("the replacement is created");

        open_target(&pin.root(), &target)
            .await
            .expect("the store opens through the descriptor");

        assert!(
            fs::metadata(moved.join("lmdb").join("data.mdb")).is_ok(),
            "the store landed in the directory the pin holds"
        );
        assert!(
            fs::metadata(target.join("lmdb")).is_err(),
            "and nothing was written into the replacement"
        );
        let error = pin
            .verify(&target)
            .expect_err("the operator's path no longer names the pinned inode");
        assert!(
            error
                .to_string()
                .contains("replaced between check and open"),
            "{error}"
        );
    }

    /// Copies an environment's files into a directory of their own, so the copy is an inode no
    /// environment in this process has opened: heed registers an environment by its canonical
    /// path, and a second open of one path with different flags is refused.
    #[allow(clippy::expect_used)]
    fn copy_store(from: &Path, into: &Path) {
        fs::create_dir_all(into).expect("the copied store directory is made");
        for entry in fs::read_dir(from).expect("the store directory reads") {
            let entry = entry.expect("an entry reads");
            fs::copy(entry.path(), into.join(entry.file_name())).expect("the store file is copied");
        }
    }

    /// An environment with no rows and a manifest that records it complete, both written where
    /// the command is not going to look: a test copies them to its target, so what the command
    /// opens there is an inode this process has never opened.
    #[allow(clippy::expect_used)]
    fn prepared_migration() -> tempfile::TempDir {
        let prepared = tempfile::tempdir().expect("a temporary directory");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("the test runtime builds")
            .block_on(async {
                LmdbBackend::open(prepared.path())
                    .await
                    .expect("the store opens");
            });
        let mut manifest = Manifest::fresh();
        for table in MigratedTable::ALL {
            manifest.entry(table).complete = true;
        }
        write_manifest(prepared.path(), prepared.path(), &manifest)
            .expect("the manifest is written");
        prepared
    }

    /// Runs the command over a target that is swapped in the interval between its pin and the
    /// store's open: the target is renamed away through its parent, and a fresh directory takes
    /// its name holding a store of its own.
    ///
    /// The step also asserts that it ran: both tests below would pass on an unswapped target, so
    /// a deleted `after_pin()` call would leave them green and the seam unguarded.
    #[allow(clippy::expect_used)]
    fn run_over_a_swap(verify: bool) -> (CommandOutput, String) {
        let prepared = prepared_migration();
        let temporary = tempfile::tempdir().expect("a temporary directory");
        let target = temporary.path().join("target");
        let moved = temporary.path().join("moved");
        copy_store(&prepared.path().join("lmdb"), &target.join("lmdb"));
        fs::copy(
            prepared.path().join(MANIFEST_FILE),
            target.join(MANIFEST_FILE),
        )
        .expect("the manifest is copied");

        let stepped = std::cell::Cell::new(false);
        let mut out = Vec::new();
        let output = run_with(
            MigrateOptions {
                target: target.clone(),
                batch_size: 1_000,
                verify,
            },
            &mut out,
            || {
                stepped.set(true);
                fs::rename(&target, &moved).expect("the target is renamed away");
                copy_store(&prepared.path().join("lmdb"), &target.join("lmdb"));
            },
        )
        .expect("the command answers rather than failing");
        assert!(
            stepped.get(),
            "the command ran the step between the pin and the store's open"
        );
        (
            output,
            String::from_utf8(out).expect("the command writes utf-8"),
        )
    }

    /// `run`'s `--verify` arm takes its own pin, and this is the half no grep can show: only the
    /// pinned directory holds the manifest, so an arm that opened the bare path answers
    /// `No manifest at …` and exits 1 where this exits 0.
    #[cfg(target_os = "linux")]
    #[test]
    #[allow(clippy::expect_used)]
    fn the_verify_arm_reads_the_store_its_pin_names_rather_than_the_replacement() {
        let (output, text) = run_over_a_swap(true);
        assert_eq!(output.exit_code, 0, "got:\n{text}");
        assert!(
            text.contains("Verified 9 tables"),
            "the arm read the store its pin names, got:\n{text}"
        );
    }

    /// The same swap on the other arm that verifies: a complete manifest with no `--verify` set.
    #[cfg(target_os = "linux")]
    #[test]
    #[allow(clippy::expect_used)]
    fn the_completed_manifest_arm_reads_the_store_its_pin_names_rather_than_the_replacement() {
        let (output, text) = run_over_a_swap(false);
        assert_eq!(output.exit_code, 0, "got:\n{text}");
        assert!(
            text.contains("Verified 9 tables"),
            "the arm read the store its pin names, got:\n{text}"
        );
    }
}
