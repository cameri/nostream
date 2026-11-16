//! `migrate pg-to-lmdb` where the copy cannot run.
//!
//! The copy reads and writes Unix file modes, refuses a target by its owner's uid and reads the
//! caller's from `/proc/self/status`, so the whole command lives in `migrate.rs` behind
//! `cfg(unix)`. The command still has to exist everywhere — a `main.rs` that cannot name it would
//! need its own `cfg` arm — so this module supplies the same `MigrateOptions` and a `run` that
//! refuses with the reason, which is what an operator on another platform needs to read.

use std::io::Write;
use std::path::PathBuf;

use crate::config::CommandOutput;
use crate::error::CliError;

/// The options one run carries. Kept in step with `migrate::MigrateOptions`, which is the arm
/// that uses them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrateOptions {
    /// The store root: the environment is `<target>/lmdb`, the manifest `<target>/migration-manifest.json`.
    pub target: PathBuf,
    /// Rows per batch, which is also the page size verify reads with.
    pub batch_size: usize,
    /// Verify the target against its manifest and copy nothing.
    pub verify: bool,
}

/// `migrate pg-to-lmdb`: refused, naming the platform as the reason and answering exit code 1.
///
/// `migrate_cli_unsupported.rs` pins the line and the code, and the `windows-latest` job in
/// `checks.yml` runs it there.
pub fn run(_options: MigrateOptions, out: &mut dyn Write) -> Result<CommandOutput, CliError> {
    writeln!(out, "migrate pg-to-lmdb is unsupported on this platform")
        .map_err(|e| CliError::Migrate(e.to_string()))?;
    Ok(CommandOutput {
        lines: Vec::new(),
        exit_code: 1,
    })
}
