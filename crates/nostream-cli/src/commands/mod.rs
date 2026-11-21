//! The CLI commands, one module per group the capture names: `config` (all six variants),
//! `start`/`stop`/`update` over the compose seam, `info`, `export`, `clean-db`, `clean`, `seed`,
//! `invite`, `setup` and `import`. Only `tui` remains a labelled stub.

pub mod clean;
pub mod clean_db;
pub mod config;
pub mod export;
pub mod import;
pub mod info;
pub mod invite;
/// The copy needs Unix file modes, so the whole command is Unix-only and the other platform
/// gets a refusal with the same option type, which is what keeps `main.rs` free of a `cfg` arm.
#[cfg(unix)]
pub mod migrate;
#[cfg(not(unix))]
#[path = "migrate_unsupported.rs"]
pub mod migrate;
pub mod seed;
pub mod setup;
pub mod start;
pub mod stop;
pub mod update;
