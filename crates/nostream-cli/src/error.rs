//! The CLI error type. `anyhow` lives in the binary; the library keeps its own type.
//!
//! Three failure **shapes** and their exit codes are the capture's, not this crate's choice
//! (`docs/rewrite/decisions/0015-cli-surface.md` D3): a failure thrown out of a command is
//! prefixed `Error: ` and exits 2 (`Usage`) or 1 (`Command`); a failure the command reports
//! itself is printed bare and exits with the code it chose (`Config`, and `Reported` for more
//! than one line); and a `--json` failure is the capture's `{"error":{…}}` envelope (`Json`).
//! Each command picks its shape from the capture's own class — `src/cli/index.ts:38-42`,
//! `:116-135` and `src/utils/output.ts:27-29` — never by convenience.

use thiserror::Error;

/// Errors raised by the CLI library.
#[derive(Debug, Error)]
pub enum CliError {
    /// A Phase 1 stub. The module names the call that is not implemented yet.
    #[error("not implemented in Phase 1 (job 005): {module}")]
    NotImplemented { module: &'static str },

    /// A failure the command reports itself, one line, written to stderr **without** a prefix
    /// (`logError`, `src/cli/utils/output.ts:27-29`). Exit code 1.
    #[error("{0}")]
    Config(String),

    /// A failure the command reports itself, several lines, written verbatim to stderr. Exit
    /// code 1, or the code the report carries.
    #[error("{}", lines.join(" | "))]
    Reported { lines: Vec<String>, exit_code: u8 },

    /// Lines the command already earned, then the failure it reports: the first go to
    /// **stdout**, where a successful run writes them, and only the failure's lines to stderr
    /// at `exit_code`.
    ///
    /// `config set --restart` is the case this exists for: the file is written before the
    /// restart runs, so `Updated <path>` is a fact whatever the restart does — the capture logs
    /// it with `logInfo` (stdout) and only the failed step with `spinner.fail` (stderr), which
    /// an all-stderr `Reported` cannot reproduce (`src/cli/commands/config.ts:152-155`).
    #[error("{}", lines.join(" | "))]
    ReportedAfter {
        output: Vec<String>,
        lines: Vec<String>,
        exit_code: u8,
    },

    /// A thrown usage failure (`CliUsageError`): `Error: <message>` on stderr, exit code 2.
    #[error("{0}")]
    Usage(String),

    /// A thrown plain failure (`throw new Error(…)`): `Error: <message>` on stderr, exit 1.
    #[error("{0}")]
    Command(String),

    /// A failure in a command that was asked for `--json`: the capture's envelope,
    /// `{"error":{"message":…,"code":N}}`, on stderr with exit code `N`
    /// (`src/cli/index.ts:129-131`).
    #[error("{message}")]
    Json { message: String, code: u8 },

    /// The import could not run: a bad argument, a missing file or a storage failure.
    #[error("{0}")]
    Import(String),

    /// The migration could not run: a refused row, an unusable manifest or a store that would
    /// not open.
    #[error("{0}")]
    Migrate(String),
}

impl CliError {
    /// A reported failure of one line, exit 1: the capture's `logError` sites.
    pub fn reported_line(line: impl Into<String>) -> Self {
        Self::Config(line.into())
    }

    /// A reported failure of several lines, exit 1.
    pub fn reported(lines: Vec<String>) -> Self {
        Self::Reported {
            lines,
            exit_code: 1,
        }
    }

    /// A thrown plain failure: `Error: <message>` on stderr, exit 1.
    pub fn command(message: impl Into<String>) -> Self {
        Self::Command(message.into())
    }

    /// A thrown usage failure: `Error: <message>` on stderr, exit 2.
    pub fn usage(message: impl Into<String>) -> Self {
        Self::Usage(message.into())
    }

    /// The `--json` form of a failure, which the capture renders as the envelope.
    pub fn json(message: impl Into<String>, code: u8) -> Self {
        Self::Json {
            message: message.into(),
            code,
        }
    }
}
