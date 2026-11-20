//! The shared command context, the hand-written top-level page, the pre-parse, the dispatch and
//! the renderer: the four things `src/cli/index.ts` does around the command modules.
//!
//! The capture's entry point answers `--help`/`-h` and an empty command line with the page on
//! stdout at exit 0, `-v`/`--version` with the version page, and an unknown first word with
//! `Unknown command: <word>` on stderr plus the page on stdout at exit 2, and only then hands the
//! arguments to its parser (`src/cli/index.ts:470-531`). A port built on clap repeats that order
//! here, in one place, so the parser never sees a case that has its own answer (R1, C1).

use std::future::Future;
use std::path::PathBuf;
use std::process::ExitCode;

use crate::config::CommandOutput;
use crate::env_file::Environment;
use crate::error::CliError;

/// What a command needs from the process it runs in.
pub struct Context {
    /// The working directory the command resolves its files against — `resources/`,
    /// `seeds/`, the compose overlays and `.env` are all read relative to it, exactly as the
    /// capture's `getProjectPath` reads them.
    pub cwd: PathBuf,
    /// The process environment with the `.env` layer behind it (`src/cli/utils/env-config.ts`).
    pub env: Environment,
    runtime: tokio::runtime::Runtime,
}

impl Context {
    /// A context for the process's own working directory.
    pub fn new() -> Result<Self, CliError> {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self::at(cwd)
    }

    /// A context for `cwd`, which the tests name.
    pub fn at(cwd: PathBuf) -> Result<Self, CliError> {
        let env = Environment::load(&cwd);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| CliError::command(format!("unable to start a runtime: {error}")))?;
        Ok(Self { cwd, env, runtime })
    }

    /// Drives one command's future to completion on the context's runtime.
    pub fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }
}

/// The version page (V44): `nostream/<CARGO_PKG_VERSION>`, the crate's own version, which is the
/// same string `info` prints as `Nostream v<version>` and the admin diagnostics serve.
pub fn version_line() -> String {
    format!("nostream/{}", env!("CARGO_PKG_VERSION"))
}

/// The top-level page, on stdout, at exit 0.
///
/// It is the capture's `cac` page (`Values` V2) with two edits, both from the removal of `dev`
/// (R17): the `  dev [...args]` row and the footer's `  $ nostream dev --help` line are gone.
/// The version line is the crate's own (R2).
pub fn page_lines() -> Vec<String> {
    [
        version_line(),
        String::new(),
        "Usage:".to_owned(),
        "  $ nostream <command> [options]".to_owned(),
        String::new(),
        "Commands:".to_owned(),
        "  start [...args]            Start Nostream (Docker Compose)".to_owned(),
        "  stop [...args]             Stop Nostream".to_owned(),
        "  info                       Show relay/runtime info".to_owned(),
        "  update [...args]           Pull latest git changes and restart relay".to_owned(),
        "  clean                      Clean Docker resources (legacy script replacement)"
            .to_owned(),
        "  import [file] [...args]    Import events from .jsonl or .json".to_owned(),
        "  export [output] [...args]  Export events to file".to_owned(),
        "  seed                       Seed relay with test data".to_owned(),
        "  invite [...args]           Mint NIP-43 invite codes".to_owned(),
        "  setup                      Initial interactive setup".to_owned(),
        "  config [...args]           Manage settings".to_owned(),
        String::new(),
        "For more info, run any command with the `--help` flag:".to_owned(),
        "  $ nostream start --help".to_owned(),
        "  $ nostream stop --help".to_owned(),
        "  $ nostream info --help".to_owned(),
        "  $ nostream update --help".to_owned(),
        "  $ nostream clean --help".to_owned(),
        "  $ nostream import --help".to_owned(),
        "  $ nostream export --help".to_owned(),
        "  $ nostream seed --help".to_owned(),
        "  $ nostream invite --help".to_owned(),
        "  $ nostream setup --help".to_owned(),
        "  $ nostream config --help".to_owned(),
        String::new(),
        "Options:".to_owned(),
        "  -h, --help     Display this message".to_owned(),
        "  -v, --version  Display version number".to_owned(),
    ]
    .to_vec()
}

/// The `--json` failure envelope: `{"error":{"message":…,"code":N}}` (`src/cli/index.ts:129-131`).
///
/// It is a struct rather than a `serde_json::Value` because a map's key order is not the
/// contract's: the capture writes `message` first, and only a struct's declaration order is
/// guaranteed to keep it there.
#[derive(serde::Serialize)]
struct ErrorEnvelope<'a> {
    error: ErrorBody<'a>,
}

#[derive(serde::Serialize)]
struct ErrorBody<'a> {
    message: &'a str,
    code: u8,
}

/// Writes one command's `Result` — the single place that picks a stream and an exit code.
///
/// The three failure shapes are the capture's (R3, V63): a failure thrown out of a command is
/// prefixed `Error: ` and exits 2 (`Usage`) or 1 (`Command`); a failure the command reports
/// itself is written bare, line by line, with the code it chose (`Config`, `Reported`); and a
/// `--json` failure is the envelope. `Import` and `Migrate` keep the prefixes they shipped.
pub fn render(result: Result<CommandOutput, CliError>) -> ExitCode {
    match result {
        Ok(output) => {
            for line in &output.lines {
                println!("{line}");
            }
            output.exit_code()
        }
        Err(error) => {
            let code = match error {
                CliError::Usage(message) => {
                    eprintln!("Error: {message}");
                    2
                }
                CliError::Command(message) => {
                    eprintln!("Error: {message}");
                    1
                }
                CliError::Config(line) => {
                    eprintln!("{line}");
                    1
                }
                CliError::Reported { lines, exit_code } => {
                    for line in lines {
                        eprintln!("{line}");
                    }
                    exit_code
                }
                CliError::Json { message, code } => {
                    let envelope = ErrorEnvelope {
                        error: ErrorBody {
                            message: &message,
                            code,
                        },
                    };
                    match serde_json::to_string(&envelope) {
                        Ok(rendered) => eprintln!("{rendered}"),
                        Err(_) => {
                            eprintln!("{{\"error\":{{\"message\":\"error\",\"code\":{code}}}}}")
                        }
                    }
                    code
                }
                CliError::NotImplemented { module } => {
                    eprintln!("not implemented in Phase 1 (job 005): {module}");
                    1
                }
                CliError::Import(message) => {
                    eprintln!("Import failed: {message}");
                    1
                }
                CliError::Migrate(message) => {
                    eprintln!("Migration failed: {message}");
                    1
                }
            };
            ExitCode::from(code)
        }
    }
}
