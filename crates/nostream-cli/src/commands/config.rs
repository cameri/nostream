//! The `config` subcommand: validate, list, get, set and `env`, on top of `crate::config`.

use std::path::Path;

use crate::app::Context;
use crate::commands::start::StartOptions;
use crate::commands::stop::StopOptions;
use crate::config::{CommandOutput, ValueType, resolve_paths};
use crate::error::CliError;

/// Runs `config validate`.
pub fn validate(
    cwd: &Path,
    config_dir: Option<&Path>,
    config_file: Option<&Path>,
) -> Result<CommandOutput, CliError> {
    crate::config::validate(&resolve_paths(cwd, config_dir), config_file)
}

/// Runs `config list`.
pub fn list(cwd: &Path, config_dir: Option<&Path>, json: bool) -> Result<CommandOutput, CliError> {
    crate::config::list(&resolve_paths(cwd, config_dir), json)
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

/// One `config set` request, as the parser read it.
pub struct SetRequest<'a> {
    pub path: &'a str,
    pub value: &'a str,
    /// `--type`, which the capture treats as `inferred` for anything but `json`.
    pub value_type: Option<&'a str>,
    /// Validation runs unless `--no-validate`.
    pub validate: bool,
    /// `--restart`: stop and start the stack after the write.
    pub restart: bool,
}

/// Runs `config set <path> <value>`, and the restart `--restart` asks for.
///
/// A failed restart does not swallow the write: the settings file already changed, so the
/// `Updated <path>` line is reported with the restart's own failure and its code, as the
/// capture logs the line before it restarts (`src/cli/commands/config.ts:152-155`).
pub fn set(
    context: &Context,
    config_dir: Option<&Path>,
    request: SetRequest<'_>,
) -> Result<CommandOutput, CliError> {
    let value_type = request
        .value_type
        .and_then(ValueType::parse)
        .unwrap_or(ValueType::Inferred);

    let output = crate::config::set(
        &resolve_paths(&context.cwd, config_dir),
        request.path,
        request.value,
        value_type,
        request.validate,
    )?;

    if !request.restart {
        return Ok(output);
    }

    let restarted = match context.block_on(restart(context)) {
        Ok(restarted) => restarted,
        Err(CliError::Reported { lines, exit_code }) => {
            let mut reported = output.lines;
            reported.extend(lines);
            return Err(CliError::Reported {
                lines: reported,
                exit_code,
            });
        }
        Err(other) => return Err(other),
    };

    let mut lines = output.lines;
    lines.extend(restarted.lines);
    Ok(CommandOutput::with_code(lines, restarted.exit_code))
}

/// `restartRelay`: stop every overlay, then start, answering the step that failed.
async fn restart(context: &Context) -> Result<CommandOutput, CliError> {
    let stopped = crate::commands::stop::stop(context, &StopOptions::every_overlay(), &[]).await?;

    if stopped.exit_code != 0 {
        return Err(CliError::Reported {
            lines: vec!["Restart failed while stopping relay".to_owned()],
            exit_code: stopped.exit_code,
        });
    }

    let started = crate::commands::start::start(context, &StartOptions::default(), &[]).await?;

    if started.exit_code != 0 {
        return Err(CliError::Reported {
            lines: vec!["Restart failed while starting relay".to_owned()],
            exit_code: started.exit_code,
        });
    }

    Ok(CommandOutput::print(vec!["Relay restarted".to_owned()]))
}

/// Runs `config env list`.
pub fn env_list(cwd: &Path, show_secrets: bool) -> Result<CommandOutput, CliError> {
    crate::config::env_list(cwd, show_secrets)
}

/// Runs `config env get <key>`.
pub fn env_get(cwd: &Path, key: &str, show_secrets: bool) -> Result<CommandOutput, CliError> {
    crate::config::env_get(cwd, key, show_secrets)
}

/// Runs `config env set <key> <value>`.
pub fn env_set(cwd: &Path, key: &str, value: &str) -> Result<CommandOutput, CliError> {
    crate::config::env_set(cwd, key, value)
}

/// Runs `config env validate`.
pub fn env_validate(cwd: &Path) -> Result<CommandOutput, CliError> {
    crate::config::env_validate(cwd)
}
