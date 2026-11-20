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
//! The surface is `app.rs` — the pre-parse, the capture's page, the renderer and the dispatch —
//! over `commands/`, the seams a command drives (`compose`, `store`, `env_file`, `bootstrap`,
//! `compression`, `process` in `nostream-services`), and the settings reader in `config.rs`.
//! Only `tui` and `CliError::NotImplemented` are still labelled stubs.

/// The capture's numeric bound, `Number.isSafeInteger`: the largest integer a JavaScript number
/// holds exactly. The commands that take a number from the command line refuse anything above it
/// with the capture's own message, because past it the capture's parser refuses too (V22, V39,
/// Amendment 3).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub mod app;
pub mod bootstrap;
pub mod commands;
pub mod compose;
pub mod compression;
pub mod config;
pub mod env_file;
pub mod error;
pub mod store;
pub mod tui;

pub use error::CliError;
