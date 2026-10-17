//! `nostream-cli` owns the operator command line: the `config` subcommands (implemented on top
//! of `nostream-config`), the operational scripts and the process supervisor.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/cli/` (28 files: commands, TUI, utils)
//! - `src/scripts/{benchmark-queries,export-events}.ts`
//! - `src/import-events.ts`, `src/clean-db.ts`
//!
//! Phase 1 implements `config validate` and `config get` end to end; the remaining commands,
//! the TUI and the docker/process supervisors are labelled stubs (Phase 2).

pub mod commands;
pub mod config;
pub mod docker;
pub mod error;
pub mod process;
pub mod tui;

pub use error::CliError;
