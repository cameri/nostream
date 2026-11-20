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
/// shortcut: a failed `--restart` reports its own step's failure but not the `Updated <path>`
/// line the capture prints before restarting, because a command returns either its lines or its
/// failure and not both; upgrade when a criterion pins the pair.
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

    let restarted = context.block_on(restart(context))?;
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
