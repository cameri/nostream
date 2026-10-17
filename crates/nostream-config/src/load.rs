//! Loading, merging and the fallback rule. Mirrors `src/utils/settings.ts`
//! `SettingsStatic.createSettings()` and the loader half of `src/utils/settings-config.ts`.
//!
//! The fallback rule is the capture's: a user configuration that cannot be read or does not
//! validate never aborts the process. It is reported as [`Issue`] values and the caller gets
//! the shipped defaults, so a broken `settings.yaml` cannot stop a relay from starting.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde_yaml::Value;

use crate::error::ConfigError;
use crate::issue::Issue;
use crate::path::{PathToken, format_path_tokens};
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

/// Trims trailing separators from a path for lstat: POSIX resolves a trailing slash through
/// a symlink, so `…/link/` on a dangling link reports ENOENT rather than the link itself;
/// trimming is what lets the second probe see the entry.
///
/// The trim removes separator *bytes from the path's own text* — not components: `…/config/`
/// must become `…/config`, not `…`. Root `/` is left as `/` (a root has nothing to probe),
/// and non-UTF-8 paths are handled because the work is on `OsStr` bytes, not a `to_str`.
#[cfg(unix)]
fn trim_trailing_separators(path: &Path) -> &Path {
    use std::os::unix::ffi::OsStrExt;

    let bytes = path.as_os_str().as_bytes();
    let mut end = bytes.len();
    while end > 1 && bytes[end - 1] == b'/' {
        end -= 1;
    }
    OsStr::from_bytes(&bytes[..end]).as_ref()
}

/// Windows twin of the unix trim: drop trailing `\` (and `/`) separators, never the last
/// character (a bare `C:\` root stays itself).
///
/// Safe on purpose: the unix arm can slice `OsStr` bytes, but `OsStr::from_encoded_bytes_unchecked`
/// is `unsafe`, which the workspace denies. A lossy round-trip is honest here — the result is only
/// ever `lstat`-ed, and a Windows path that is not valid UTF-8 has no `settings.yaml` we can read.
#[cfg(windows)]
fn trim_trailing_separators(path: &Path) -> PathBuf {
    trim_trailing_separators_lossy(path)
}

/// The Windows half, compiled and tested on every platform so it cannot rot unseen: the
/// `#[cfg(windows)]` arm above is the only caller in a Windows build, and this makes the
/// body reachable from a unix test.
#[cfg_attr(not(windows), allow(dead_code))] // compiled on every platform so a test covers it
fn trim_trailing_separators_lossy(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let trimmed = text.trim_end_matches(['\\', '/']);
    // A root has nothing to probe: `/`, a bare `C:` after its separator is trimmed, or a
    // relative path that is all separators.
    if trimmed.is_empty() || trimmed.ends_with(':') {
        PathBuf::from(text.as_ref())
    } else {
        PathBuf::from(trimmed)
    }
}

/// Reads the user's overrides: `settings.yaml` first, then the deprecated `settings.json`.
///
/// Returns `None` when neither file exists. An empty YAML file is an empty override set.
/// A path that exists but is not a regular file is an error ([`ConfigError::NotAFile`]),
/// not absence: falling through would hide an unusable `settings.yaml` behind the legacy
/// file or the defaults.
///
/// The directory is created only by the mutating callers (the guided editor, the save path);
/// a read probe reports `Ok(None)` for an absent directory instead of materialising one —
/// `nostreamd --check` runs this and must not write.
pub fn load_user_settings(config_base_dir: &Path) -> Result<Option<Value>, ConfigError> {
    // The probe is symlink-aware, in the capture's direction: `fs::metadata` follows the
    // final component (the capture's `existsSync` does too), so a config dir that is a
    // symlink to a real directory is accepted and its target is used. When the followed
    // stat reports NotFound, `symlink_metadata` (lstat, trailing separators trimmed —
    // POSIX resolves a trailing slash through the link) distinguishes a dangling link
    // entry (`NotADirectory`) from true absence (`Ok(None)`); any other followed-stat
    // error (EACCES on a parent, ELOOP, ENOTDIR) is loud: the operator named a location
    // the daemon cannot even inspect.
    match std::fs::metadata(config_base_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(ConfigError::NotADirectory {
                path: config_base_dir.to_path_buf(),
            });
        }
        Err(followed) if followed.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(unix)]
            let without_trailing: &Path = trim_trailing_separators(config_base_dir);
            #[cfg(windows)]
            let without_trailing: PathBuf = trim_trailing_separators(config_base_dir);
            match std::fs::symlink_metadata(without_trailing) {
                Ok(_) => {
                    // The entry itself exists (a dangling link, or a link with trailing
                    // separators that POSIX forced us to resolve): a finding, not silence.
                    return Err(ConfigError::NotADirectory {
                        path: config_base_dir.to_path_buf(),
                    });
                }
                Err(link_error) if link_error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(None);
                }
                Err(source) => {
                    return Err(ConfigError::StatSettingsPath {
                        path: config_base_dir.to_path_buf(),
                        source,
                    });
                }
            }
        }
        Err(source) => {
            return Err(ConfigError::StatSettingsPath {
                path: config_base_dir.to_path_buf(),
                source,
            });
        }
    }

    let settings_file = config_base_dir.join("settings.yaml");
    if probe_settings_file(&settings_file)? {
        let document = load_document(&settings_file)?;
        return Ok(Some(if document.is_null() {
            Value::Mapping(serde_yaml::Mapping::new())
        } else {
            document
        }));
    }

    let legacy_file = config_base_dir.join("settings.json");
    if probe_settings_file(&legacy_file)? {
        let document = load_document(&legacy_file)?;
        return Ok(Some(if document.is_null() {
            Value::Mapping(serde_yaml::Mapping::new())
        } else {
            document
        }));
    }

    Ok(None)
}

/// Classifies one settings file path: `true` reads it, `false` moves to the next candidate.
///
/// The capture decides with `fs.existsSync(settingsPath)` and then reads unconditionally, so
/// a path that exists but is not a regular file (a directory named `settings.yaml`, a FIFO)
/// is a *failure*, not absence — treating it as absent would fall through to the deprecated
/// `settings.json` or to the shipped defaults and let `--check` report a clean config while
/// the operator's real file is unusable. Only a path that does not exist falls through; a
/// dangling symlink reports `existsSync` false in the capture too, so it also falls through.
/// An inspection the process cannot perform at all (EACCES on the parent, ELOOP) is loud.
fn probe_settings_file(path: &Path) -> Result<bool, ConfigError> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(ConfigError::NotAFile {
            path: path.to_path_buf(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(ConfigError::StatSettingsPath {
            path: path.to_path_buf(),
            source,
        }),
    }
}

/// Deep-merges user overrides over the defaults (`mergeDeepRight`).
pub fn merge(defaults: &Value, user: &Value) -> Value {
    merge_deep_right(defaults, user)
}

/// Narrows a validated document to [`Settings`], naming the field a value cannot fit.
///
/// `validate_document` grades a document the way the capture does, where every number is a
/// JavaScript `number`; the typed schema distinguishes `u64`, `i64` and `f64`. A rate-limit
/// `period` of `1000.5` is therefore a positive number to the validator and unrepresentable
/// to [`crate::settings::RateLimit::period`], so validating alone could approve a document
/// the daemon then refuses — and the refusal replaces the operator's whole configuration
/// with the shipped defaults. Both the daemon and `config validate` call this, so neither
/// can approve what the other cannot load.
///
/// The schema walk runs only when the conversion fails: the typed defaults are serialized
/// back to a document — where a `u64` stays an integer and an `f64` becomes a float — and
/// the first leaf whose number the candidate cannot represent names the field. Messages
/// carry the class, never the operator's value.
pub fn fit(candidate: &Value, defaults: &Value) -> Result<Settings, Issue> {
    match serde_yaml::from_value::<Settings>(candidate.clone()) {
        Ok(settings) => Ok(settings),
        Err(error) => {
            let projection = serde_yaml::from_value::<Settings>(defaults.clone())
                .ok()
                .and_then(|typed| serde_yaml::to_value(typed).ok());
            if let Some(projection) = projection
                && let Some(issue) = find_misfit(&projection, candidate, &mut Vec::new())
            {
                return Err(issue);
            }
            // Nothing the numeric walk can name: report the class, and the parse location
            // when serde exposes one — never the value, which would echo into logs.
            let location = error.location().map_or_else(String::new, |location| {
                format!(" at line {} column {}", location.line(), location.column())
            });
            Err(Issue::new(
                "$",
                format!("settings do not fit the typed schema{location}"),
            ))
        }
    }
}

/// Walks the typed projection against the candidate, returning the first leaf whose number
/// the field's type cannot represent. Only numbers are compared: every other mismatch is
/// already an issue from `validate_document`'s shape walk.
///
/// The projection cannot tell a `u32` field from an `i64` one — serde_yaml marks any
/// non-negative integer as a positive integer — so a value too large for an `i64` field falls
/// through to [`fit`]'s class-level finding rather than being named here.
fn find_misfit(schema: &Value, candidate: &Value, path: &mut Vec<PathToken>) -> Option<Issue> {
    match (schema, candidate) {
        (Value::Mapping(schema), Value::Mapping(candidate)) => {
            for (key, candidate_value) in candidate {
                let Some(key) = key.as_str() else {
                    continue;
                };
                let Some(schema_value) = schema.get(key) else {
                    continue;
                };
                path.push(PathToken::Key(key.to_owned()));
                let misfit = find_misfit(schema_value, candidate_value, path);
                path.pop();
                if misfit.is_some() {
                    return misfit;
                }
            }
            None
        }
        (Value::Sequence(schema), Value::Sequence(candidate)) => {
            // A `Vec<T>` has one element type, so the first default entry is the schema for
            // every element; a user's list may be longer or shorter than the defaults'.
            let schema_entry = schema.first()?;
            for (index, candidate_value) in candidate.iter().enumerate() {
                path.push(PathToken::Index(index));
                let misfit = find_misfit(schema_entry, candidate_value, path);
                path.pop();
                if misfit.is_some() {
                    return misfit;
                }
            }
            None
        }
        (Value::Number(schema_number), Value::Number(candidate_number)) => {
            let message = if schema_number.is_f64() {
                // Any number the document can carry fits an `f64` field.
                return None;
            } else if schema_number.is_u64() && !candidate_number.is_u64() {
                if candidate_number.as_i64().is_some() {
                    "must not be negative"
                } else {
                    "must be a whole number"
                }
            } else if schema_number.is_i64() && candidate_number.as_i64().is_none() {
                "must fit a signed 64-bit integer"
            } else {
                return None;
            };
            Some(Issue::new(format_path_tokens(path), message))
        }
        _ => None,
    }
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

    match fit(&merged, &defaults) {
        Ok(settings) => Ok(LoadOutcome {
            settings,
            issues,
            used_defaults: false,
        }),
        Err(issue) => Ok(LoadOutcome {
            settings: defaults_settings,
            issues: vec![issue],
            used_defaults: true,
        }),
    }
}

#[cfg(test)]
mod trim_tests {
    use super::trim_trailing_separators_lossy;
    use std::path::{Path, PathBuf};

    /// The Windows arm's body, exercised on every platform so it cannot rot unseen.
    #[test]
    fn the_lossy_trim_drops_only_trailing_separators() {
        assert_eq!(
            trim_trailing_separators_lossy(Path::new("/srv/relay/config/")),
            PathBuf::from("/srv/relay/config")
        );
        assert_eq!(
            trim_trailing_separators_lossy(Path::new("dangling/")),
            PathBuf::from("dangling")
        );
        assert_eq!(
            trim_trailing_separators_lossy(Path::new("/")),
            PathBuf::from("/")
        );
        assert_eq!(
            trim_trailing_separators_lossy(Path::new(r"C:\")),
            PathBuf::from(r"C:\")
        );
        assert_eq!(
            trim_trailing_separators_lossy(Path::new("/srv/relay")),
            PathBuf::from("/srv/relay")
        );
    }
}
