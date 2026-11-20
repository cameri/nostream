//! The config subcommands' shared logic, on top of `nostream-config`.
//!
//! Defaults resolve from the process working directory (`resources/default-settings.yaml`),
//! exactly as `src/utils/settings-paths.ts` does; `--config-dir` overrides `NOSTR_CONFIG_DIR`.
//!
//! Mirrors `src/cli/commands/config.ts`: `list` dumps the merged settings, `get` reads one
//! dot-path, `set` validates the path against the defaults, parses the value, validates the
//! merged result and saves with a backup. Validation findings are reported with the capture's
//! bytes and its class (`Config update rejected by validation:` bare on stderr, exit 1).

use std::path::Path;
use std::process::ExitCode;

use chrono::Utc;
use nostream_config::path::{get_by_path, parse_typed_json, parse_value, set_by_path};
use nostream_config::store::save_with_backup;
use nostream_config::{
    Issue, SettingsPaths, fit, load_defaults, load_user_settings, merge, validate_document,
};
use serde_yaml::Value;

use crate::env_file;
use crate::error::CliError;

/// Resolves the paths, honouring `--config-dir` over the environment.
pub fn resolve_paths(cwd: &Path, config_dir: Option<&Path>) -> SettingsPaths {
    match config_dir {
        Some(dir) => SettingsPaths::from_config_dir(cwd, dir),
        None => SettingsPaths::resolve(cwd),
    }
}

/// The outcome of one command: lines to print and the process exit code.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CommandOutput {
    pub lines: Vec<String>,
    pub exit_code: u8,
}

impl CommandOutput {
    pub fn exit_code(&self) -> ExitCode {
        ExitCode::from(self.exit_code)
    }

    /// Lines on stdout, exit 0.
    pub fn print(lines: Vec<String>) -> Self {
        Self {
            lines,
            exit_code: 0,
        }
    }

    /// Lines on stdout, the given code: the capture's `logInfo` then `return N`.
    pub fn with_code(lines: Vec<String>, exit_code: u8) -> Self {
        Self { lines, exit_code }
    }
}

/// The defaults document and the merged effective document, without validation.
///
/// The capture's `loadMergedSettings` merges and does **not** validate: a document the validator
/// dislikes still loads, which is what lets `info`, `invite` and `export` read a store the
/// operator has not finished configuring. `config validate` is the command that says so.
pub fn merged_documents(paths: &SettingsPaths) -> Result<(Value, Value), CliError> {
    let defaults = load_defaults(&paths.default_settings_file).map_err(settings_failure)?;
    let user = load_user_settings(&paths.config_base_dir).map_err(settings_failure)?;
    let merged = match &user {
        Some(user) => merge(&defaults, user),
        None => defaults.clone(),
    };
    Ok((defaults, merged))
}

/// A settings file that could not be read or parsed is the **thrown** class:
/// `Error: <message>` on stderr at exit 1, the shape the capture's own handler gives a failure
/// thrown out of an action (`src/cli/index.ts:40-42`, C3's fourth row). Round 2's ux finding 2
/// measured `config list` and `config set` reporting it bare while `info`, `export`, `seed`,
/// `invite` and `clean-db` prefixed the same failure; one class, one shape.
///
/// Only the file's own failure moves: a document that loads but fails validation stays the
/// reported class (`Config update rejected by validation:`, D9's exit 2 for `config validate`).
fn settings_failure(error: nostream_config::ConfigError) -> CliError {
    CliError::command(error.to_string())
}

/// The merged document as typed settings, which is what a command that opens a store needs.
pub fn effective_settings(paths: &SettingsPaths) -> Result<nostream_config::Settings, CliError> {
    let (defaults, merged) = merged_documents(paths)?;
    fit(&merged, &defaults).map_err(|issue| CliError::Config(issue.to_string()))
}

/// Every issue `config validate` and `config set` report: the document walk, then the typed
/// schema, so a document the walk approves but the daemon cannot load is refused with the field
/// named.
pub fn validate_documents(merged: &Value, defaults: &Value) -> Vec<Issue> {
    let mut issues = validate_document(merged, defaults);
    if issues.is_empty()
        && let Err(issue) = fit(merged, defaults)
    {
        issues.push(issue);
    }
    issues
}

/// `config validate`: print one `path: message` line per issue and exit 2, or confirm a clean
/// document and exit 0.
///
/// **Exit 2 is deliberately not the capture's 1** (`docs/rewrite/decisions/0015-cli-surface.md`
/// D9): the command's exit 2 and `settings valid: N issues` are shipped, tested and agreed with
/// the daemon's `DaemonError::InvalidSettings` → 2 mapping.
pub fn validate(
    paths: &SettingsPaths,
    config_file: Option<&Path>,
) -> Result<CommandOutput, CliError> {
    let defaults = load_defaults(&paths.default_settings_file).map_err(settings_failure)?;
    let user = match config_file {
        Some(file) => Some(nostream_config::load_document(file).map_err(settings_failure)?),
        None => load_user_settings(&paths.config_base_dir).map_err(settings_failure)?,
    };
    let merged = match user {
        Some(user) => merge(&defaults, &user),
        None => defaults.clone(),
    };

    let issues = validate_documents(&merged, &defaults);

    if issues.is_empty() {
        return Ok(CommandOutput {
            lines: vec!["settings valid: 0 issues".to_owned()],
            exit_code: 0,
        });
    }

    let mut lines: Vec<String> = issues.iter().map(|issue| issue.to_string()).collect();
    lines.push(format!("settings invalid: {} issues", issues.len()));

    Ok(CommandOutput {
        lines,
        exit_code: 2,
    })
}

/// `config list`: the merged settings as YAML, or as JSON with `--json`.
pub fn list(paths: &SettingsPaths, json: bool) -> Result<CommandOutput, CliError> {
    let (_, merged) = merged_documents(paths)?;

    if json {
        return Ok(CommandOutput::print(vec![to_json(&merged)?]));
    }

    let rendered =
        serde_yaml::to_string(&merged).map_err(|error| CliError::Config(error.to_string()))?;
    Ok(CommandOutput::print(vec![rendered.trim_end().to_owned()]))
}

/// `config get`: print the value at a dot-path from the effective settings.
///
/// A missing path is the capture's `Path not found: <path>`, reported bare (`logError`) or as the
/// JSON envelope when the caller asked for `--json`.
pub fn get(paths: &SettingsPaths, path: &str, json: bool) -> Result<CommandOutput, CliError> {
    let (_, merged) = merged_documents(paths)?;

    let Some(value) =
        get_by_path(&merged, path).map_err(|error| CliError::Config(error.to_string()))?
    else {
        return Err(if json {
            CliError::json(format!("Path not found: {path}"), 1)
        } else {
            CliError::reported_line(format!("Path not found: {path}"))
        });
    };

    let rendered = if json {
        to_json(value)?
    } else {
        serialize(value)?
    };

    Ok(CommandOutput::print(vec![rendered]))
}

/// The value type `config set --type` names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueType {
    /// `parseValue`: booleans, null, integers, bigints and JSON literals, else the raw string.
    Inferred,
    /// `JSON.parse`.
    Json,
}

impl ValueType {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "inferred" => Some(Self::Inferred),
            "json" => Some(Self::Json),
            _ => None,
        }
    }
}

/// `config set <path> <value>`: validate the path against the defaults, parse the value,
/// validate the merged result unless told not to, save with a backup, print `Updated <path>`.
pub fn set(
    paths: &SettingsPaths,
    path: &str,
    raw_value: &str,
    value_type: ValueType,
    validate_before_write: bool,
) -> Result<CommandOutput, CliError> {
    let defaults = load_defaults(&paths.default_settings_file).map_err(settings_failure)?;

    let path_issues = nostream_config::path::validate_path_against_defaults(&defaults, path)
        .map_err(|error| CliError::Config(error.to_string()))?;
    if let Some(issue) = path_issues.first() {
        return Err(CliError::reported_line(issue.message.clone()));
    }

    let value = match value_type {
        ValueType::Inferred => parse_value(raw_value).to_value(),
        ValueType::Json => parse_typed_json(raw_value).map_err(CliError::reported_line)?,
    };

    let user = load_user_settings(&paths.config_base_dir)
        .map_err(settings_failure)?
        .unwrap_or(Value::Mapping(Default::default()));
    let next =
        set_by_path(&user, path, value).map_err(|error| CliError::Config(error.to_string()))?;

    if validate_before_write {
        let (_, merged) = merged_documents(paths)?;
        let introduced = get_by_path(&next, path)
            .map_err(|error| CliError::Config(error.to_string()))?
            .cloned()
            .unwrap_or(Value::Null);
        let merged_next = set_by_path(&merged, path, introduced)
            .map_err(|error| CliError::Config(error.to_string()))?;
        let issues = validate_documents(&merged_next, &defaults);

        if !issues.is_empty() {
            let mut lines = vec!["Config update rejected by validation:".to_owned()];
            lines.extend(
                issues
                    .iter()
                    .map(|issue| format!("- {}: {}", issue.path, issue.message)),
            );
            return Err(CliError::Reported {
                lines,
                exit_code: 1,
            });
        }
    }

    save(paths, &next)?;

    Ok(CommandOutput::print(vec![format!("Updated {path}")]))
}

/// Writes the settings document with a timestamped backup of the previous file.
pub fn save(paths: &SettingsPaths, document: &Value) -> Result<(), CliError> {
    save_with_backup(paths, document, Utc::now())
        .map_err(|error| CliError::Config(error.to_string()))
}

/// `config env list`: the `.env` table, sorted by key, secrets masked unless `--show-secrets`.
pub fn env_list(cwd: &Path, show_secrets: bool) -> Result<CommandOutput, CliError> {
    let environment = env_file::Environment::load(cwd);
    let values = environment.file_values();

    if values.is_empty() {
        return Ok(CommandOutput::print(vec![
            "No .env entries found".to_owned(),
        ]));
    }

    let lines = values
        .iter()
        .map(|(key, value)| {
            let display = if show_secrets || !env_file::is_secret_key(key) {
                value.clone()
            } else {
                env_file::mask_secret_value(value)
            };
            format!("{key}={display}")
        })
        .collect();

    Ok(CommandOutput::print(lines))
}

/// `config env get <key>`: one masked value, or the capture's two refusals.
pub fn env_get(cwd: &Path, key: &str, show_secrets: bool) -> Result<CommandOutput, CliError> {
    let key = key.trim();

    if !env_file::is_supported_key(key) {
        return Err(CliError::reported_line(format!(
            "Unsupported env key: {key}"
        )));
    }

    let environment = env_file::Environment::load(cwd);
    let Some(value) = environment.file(key) else {
        return Err(CliError::reported_line(format!("Env key not set: {key}")));
    };

    let display = if show_secrets || !env_file::is_secret_key(key) {
        value.to_owned()
    } else {
        env_file::mask_secret_value(value)
    };

    Ok(CommandOutput::print(vec![display]))
}

/// `config env set <key> <value>`: validate the pair, then replace or append the line.
pub fn env_set(cwd: &Path, key: &str, value: &str) -> Result<CommandOutput, CliError> {
    let key = key.trim();

    if !env_file::is_supported_key(key) {
        return Err(CliError::reported_line(format!(
            "Unsupported env key: {key}"
        )));
    }

    if let Some(issue) = env_file::validate_pair(key, value) {
        return Err(CliError::reported_line(issue));
    }

    let path = cwd.join(".env");
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let next = env_file::upsert_value(&content, key, value);
    std::fs::write(&path, next).map_err(|error| {
        CliError::Config(format!("unable to write {}: {error}", path.display()))
    })?;

    Ok(CommandOutput::print(vec![format!("Updated {key}")]))
}

/// `config env validate`: the label-form finding lines, or the confirmation.
pub fn env_validate(cwd: &Path) -> Result<CommandOutput, CliError> {
    let environment = env_file::Environment::load(cwd);
    let issues = env_file::validate_values(environment.file_values());

    if issues.is_empty() {
        return Ok(CommandOutput::print(vec![
            "Environment settings are valid".to_owned(),
        ]));
    }

    let mut lines = vec!["Environment validation failed:".to_owned()];
    lines.extend(
        issues.iter().map(|(key, message)| {
            format!("- {} ({key}): {message}", env_file::category_label(key))
        }),
    );

    Err(CliError::Reported {
        lines,
        exit_code: 1,
    })
}

/// `JSON.stringify(value, null, 2)`, with a bigint rendered as its digits.
pub fn to_json(value: &Value) -> Result<String, CliError> {
    let json = serde_json::to_value(value).map_err(|error| CliError::Config(error.to_string()))?;
    serde_json::to_string_pretty(&json).map_err(|error| CliError::Config(error.to_string()))
}

/// The capture's `serialize`: a string verbatim, `null` as `null`, everything else as YAML with
/// the trailing newline trimmed.
pub fn serialize(value: &Value) -> Result<String, CliError> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Null => Ok("null".to_owned()),
        other => {
            let rendered = serde_yaml::to_string(other)
                .map_err(|error| CliError::Config(error.to_string()))?;
            Ok(rendered.trim_end().to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn a_string_serialises_verbatim_and_null_as_null() {
        assert_eq!(serialize(&Value::String("abc".to_owned())).unwrap(), "abc");
        assert_eq!(serialize(&Value::Null).unwrap(), "null");
    }

    #[test]
    fn a_number_serialises_as_yaml() {
        let value: Value = serde_yaml::from_str("2048").unwrap();
        assert_eq!(serialize(&value).unwrap(), "2048");
    }

    #[test]
    fn the_value_types_parse_by_their_names() {
        assert_eq!(ValueType::parse("inferred"), Some(ValueType::Inferred));
        assert_eq!(ValueType::parse("json"), Some(ValueType::Json));
        assert_eq!(ValueType::parse("yaml"), None);
    }
}
