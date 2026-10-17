//! The `config` subcommand: validate and get, on top of `crate::config`.

use crate::config::{CommandOutput, resolve_paths};
use crate::error::CliError;
use std::path::Path;

/// Runs `config validate`.
pub fn validate(
    cwd: &Path,
    config_dir: Option<&Path>,
    config_file: Option<&Path>,
) -> Result<CommandOutput, CliError> {
    crate::config::validate(&resolve_paths(cwd, config_dir), config_file)
}

/// Runs `config get <path>`.
pub fn get(
    cwd: &Path,
    config_dir: Option<&Path>,
    path: &str,
    json: bool,
) -> Result<CommandOutput, CliError> {
    crate::config::get(&resolve_paths(cwd, config_dir), path, json)
}
