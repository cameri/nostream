//! Loading, merging and the fallback rule. Mirrors `src/utils/settings.ts`
//! `SettingsStatic.createSettings()` and the loader half of `src/utils/settings-config.ts`.
//!
//! The fallback rule is the capture's: a user configuration that cannot be read or does not
//! validate never aborts the process. It is reported as [`Issue`] values and the caller gets
//! the shipped defaults, so a broken `settings.yaml` cannot stop a relay from starting.

use std::fs;
use std::path::Path;

use serde_yaml::Value;

use crate::error::ConfigError;
use crate::issue::Issue;
use crate::paths::SettingsPaths;
use crate::settings::Settings;
use crate::validate::validate_document;
use crate::value::merge_deep_right;

/// Parses the shipped defaults document.
pub fn load_defaults(path: &Path) -> Result<Value, ConfigError> {
    let raw = fs::read_to_string(path).map_err(|source| ConfigError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    let document: Value = serde_yaml::from_str(&raw).map_err(|source| ConfigError::Parse {
        path: path.to_path_buf(),
        source,
    })?;
    if !document.is_mapping() {
        return Err(ConfigError::NotAMapping {
            path: path.to_path_buf(),
        });
    }
    Ok(document)
}

/// Reads one settings file, choosing YAML or JSON by extension.
pub fn load_document(path: &Path) -> Result<Value, ConfigError> {
    let raw = fs::read_to_string(path).map_err(|source| ConfigError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if path
        .extension()
        .is_some_and(|extension| extension == "json")
    {
        let document: Value =
            serde_json::from_str(&raw).map_err(|source| ConfigError::ParseJson {
                path: path.to_path_buf(),
                source,
            })?;
        return Ok(document);
    }
    let document: Value = serde_yaml::from_str(&raw).map_err(|source| ConfigError::Parse {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(document)
}

/// Reads the user's overrides: `settings.yaml` first, then the deprecated `settings.json`.
///
/// Returns `None` when neither file exists. An empty YAML file is an empty override set.
///
/// The directory is created only by the mutating callers (the guided editor, the save path);
/// a read probe reports `Ok(None)` for an absent directory instead of materialising one —
/// `nostreamd --check` runs this and must not write.
pub fn load_user_settings(config_base_dir: &Path) -> Result<Option<Value>, ConfigError> {
    if !config_base_dir.is_dir() {
        return Ok(None);
    }

    let settings_file = config_base_dir.join("settings.yaml");
    if settings_file.is_file() {
        let document = load_document(&settings_file)?;
        return Ok(Some(if document.is_null() {
            Value::Mapping(serde_yaml::Mapping::new())
        } else {
            document
        }));
    }

    let legacy_file = config_base_dir.join("settings.json");
    if legacy_file.is_file() {
        let document = load_document(&legacy_file)?;
        return Ok(Some(if document.is_null() {
            Value::Mapping(serde_yaml::Mapping::new())
        } else {
            document
        }));
    }

    Ok(None)
}

/// Deep-merges user overrides over the defaults (`mergeDeepRight`).
pub fn merge(defaults: &Value, user: &Value) -> Value {
    merge_deep_right(defaults, user)
}

/// The result of loading the effective settings.
#[derive(Debug, Clone)]
pub struct LoadOutcome {
    /// The effective typed settings (the defaults when `used_defaults` is true).
    pub settings: Settings,
    /// Findings from the user's document, in the validator's order. Empty on success.
    pub issues: Vec<Issue>,
    /// Whether the user's document was rejected and the defaults were substituted.
    pub used_defaults: bool,
}

/// Loads and validates the effective settings, falling back to the defaults on any failure.
pub fn load(paths: &SettingsPaths) -> Result<LoadOutcome, ConfigError> {
    let defaults = load_defaults(&paths.default_settings_file)?;
    let defaults_settings: Settings =
        serde_yaml::from_value(defaults.clone()).map_err(ConfigError::Typed)?;

    let user = match load_user_settings(&paths.config_base_dir) {
        Ok(user) => user,
        Err(error) => {
            return Ok(LoadOutcome {
                settings: defaults_settings,
                issues: vec![Issue::new(
                    "$",
                    format!("failed to load user settings: {error}"),
                )],
                used_defaults: true,
            });
        }
    };

    let Some(user) = user else {
        return Ok(LoadOutcome {
            settings: defaults_settings,
            issues: Vec::new(),
            used_defaults: false,
        });
    };

    let merged = merge(&defaults, &user);
    let issues = validate_document(&merged, &defaults);
    if !issues.is_empty() {
        return Ok(LoadOutcome {
            settings: defaults_settings,
            issues,
            used_defaults: true,
        });
    }

    match serde_yaml::from_value::<Settings>(merged) {
        Ok(settings) => Ok(LoadOutcome {
            settings,
            issues,
            used_defaults: false,
        }),
        Err(error) => {
            // serde's message renders the offending scalar (e.g. an out-of-i64 integer the
            // shape walk cannot see), which would echo an operator-supplied value into
            // stderr and logs. Report the class, not the value; the parse location rides
            // along when serde exposes one.
            let location = error.location().map_or_else(String::new, |location| {
                format!(" at line {} column {}", location.line(), location.column())
            });
            Ok(LoadOutcome {
                settings: defaults_settings,
                issues: vec![Issue::new(
                    "$",
                    format!("settings do not fit the typed schema{location}"),
                )],
                used_defaults: true,
            })
        }
    }
}
