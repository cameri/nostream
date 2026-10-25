//! The config subcommands' shared logic, on top of `nostream-config`.
//!
//! Defaults resolve from the process working directory (`resources/default-settings.yaml`),
//! exactly as `src/utils/settings-paths.ts` does; `--config-dir` overrides `NOSTR_CONFIG_DIR`.

use std::path::Path;
use std::process::ExitCode;

use nostream_config::path::get_by_path;
use nostream_config::{
    SettingsPaths, fit, load, load_defaults, load_document, load_user_settings, merge,
    validate_document,
};
use nostream_relay::relay::{BoundRefusal, refused_bounds};
use serde_yaml::Value;

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
}

/// `config validate`: print one `path: message` line per issue and exit 2, or confirm a clean
/// document and exit 0.
pub fn validate(
    paths: &SettingsPaths,
    config_file: Option<&Path>,
) -> Result<CommandOutput, CliError> {
    let defaults = load_defaults(&paths.default_settings_file)
        .map_err(|error| CliError::Config(error.to_string()))?;
    let user = match config_file {
        Some(file) => {
            Some(load_document(file).map_err(|error| CliError::Config(error.to_string()))?)
        }
        None => load_user_settings(&paths.config_base_dir)
            .map_err(|error| CliError::Config(error.to_string()))?,
    };
    let merged = match user {
        Some(user) => merge(&defaults, &user),
        None => defaults.clone(),
    };

    let mut issues = validate_document(&merged, &defaults);
    if issues.is_empty() {
        // The document walk grades JavaScript types; the typed schema is stricter. A document
        // the walk approves but the daemon cannot load (a fractional integer, for one) is
        // refused here, with the field named, so `config validate` never blesses a config the
        // daemon will discard.
        if let Err(issue) = fit(&merged, &defaults) {
            issues.push(issue);
        }
    }
    if issues.is_empty() {
        // The daemon bounds two settings at run time and ignores a value it cannot use. That is
        // not a schema fault, so it is not an issue and not fatal — but this door and the
        // daemon's `--check` are the two read-only ways an operator looks, so the verdict says
        // it here too, in the same words the daemon's gate uses (ADR 0008).
        let refused =
            match serde_yaml::from_value::<nostream_config::settings::Settings>(merged.clone()) {
                Ok(settings) => refused_bounds(&settings),
                // The document already passed `fit`, so this cannot fail; with no typed value there
                // is nothing to report rather than a reason to refuse a config the daemon can load.
                Err(_) => Vec::new(),
            };

        let mut verdict = "settings valid: 0 issues".to_owned();
        for (setting, reason) in refused {
            match reason {
                BoundRefusal::Zero => verdict.push_str(&format!(
                    "; {setting}: 0 means the default, and the relay runs with it"
                )),
                BoundRefusal::AboveCeiling(ceiling) => verdict.push_str(&format!(
                    "; {setting}: above the {ceiling} a bound accepts; \
                     the key's value is ignored"
                )),
            }
        }
        return Ok(CommandOutput {
            lines: vec![verdict],
            exit_code: 0,
        });
    }

    Ok(CommandOutput {
        lines: issues
            .iter()
            .map(|issue| issue.to_string())
            .chain(std::iter::once(format!(
                "settings invalid: {} issues",
                issues.len()
            )))
            .collect(),
        exit_code: 2,
    })
}

/// `config get`: print the value at a dot-path from the effective settings.
pub fn get(paths: &SettingsPaths, path: &str, json: bool) -> Result<CommandOutput, CliError> {
    let defaults = load_defaults(&paths.default_settings_file)
        .map_err(|error| CliError::Config(error.to_string()))?;
    let user = load_user_settings(&paths.config_base_dir)
        .map_err(|error| CliError::Config(error.to_string()))?;
    let merged = match user {
        Some(user) => merge(&defaults, &user),
        None => defaults.clone(),
    };

    let Some(value) =
        get_by_path(&merged, path).map_err(|error| CliError::Config(error.to_string()))?
    else {
        return Err(CliError::Config(format!("settings path not found: {path}")));
    };

    let rendered = if json {
        serde_json::to_string(&value).map_err(|error| CliError::Config(error.to_string()))?
    } else {
        match value {
            Value::String(text) => text.clone(),
            Value::Null => "null".to_owned(),
            other => {
                serde_json::to_string(other).map_err(|error| CliError::Config(error.to_string()))?
            }
        }
    };

    Ok(CommandOutput {
        lines: vec![rendered],
        exit_code: 0,
    })
}

/// Loads the effective settings the way the daemon does (defaults on any failure).
pub fn effective(paths: &SettingsPaths) -> Result<nostream_config::LoadOutcome, CliError> {
    load(paths).map_err(|error| CliError::Config(error.to_string()))
}
