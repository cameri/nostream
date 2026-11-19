//! The settings writer: save-with-backup, the backup list and restore, the
//! defaults filter the admin reads settings through, and the settings audit line.
//!
//! Mirrors the mutating half of `src/utils/settings-config.ts` —
//! `saveSettings` (`:526-547`), `appendSettingsAuditLog` (`:549-556`),
//! `filterSettingsAgainstDefaults` (`:487-524`), `listSettingsBackups` (`:568-586`) and
//! `restoreSettingsBackup` (`:588-606`). This is the only module that writes a settings
//! file; the loader reads them.

use std::fs;
use std::io::{ErrorKind, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::error::ConfigError;
use crate::paths::SettingsPaths;
use crate::validate::validate_document;
use crate::value::is_plain_object;

/// The backup file pattern (`^settings\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.yaml$`).
const BACKUP_NAME_LENGTH: usize = "settings.2026-11-19T13-19-32-000Z.yaml".len();

/// One backup file as the admin lists it (`SettingsBackupInfo`,
/// `src/utils/settings-config.ts:558-562`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub filename: String,
    pub created_at: String,
    pub size_bytes: u64,
}

/// The backup filename for a timestamp: `settings.<YYYY-MM-DDTHH-MM-SS-mmmZ>.yaml`
/// (`new Date().toISOString().replace(/[:.]/g, '-')`).
pub fn backup_filename(at: DateTime<Utc>) -> String {
    let stamp = at
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    format!("settings.{stamp}.yaml")
}

/// Whether `filename` is one this module writes: the capture's exact pattern, which is what
/// keeps a restore from naming a path outside the backups directory.
pub fn is_backup_filename(filename: &str) -> bool {
    if filename.len() != BACKUP_NAME_LENGTH {
        return false;
    }
    let Some(stamp) = filename
        .strip_prefix("settings.")
        .and_then(|rest| rest.strip_suffix(".yaml"))
    else {
        return false;
    };
    let bytes = stamp.as_bytes();
    // 2026-11-19T13-19-32-000Z
    if bytes.len() != 24 {
        return false;
    }
    let digits = |ranges: &[(usize, usize)]| {
        ranges
            .iter()
            .all(|(start, end)| bytes[*start..*end].iter().all(|byte| byte.is_ascii_digit()))
    };
    if !digits(&[
        (0, 4),
        (5, 7),
        (8, 10),
        (11, 13),
        (14, 16),
        (17, 19),
        (20, 23),
    ]) {
        return false;
    }
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b'-'
        && bytes[16] == b'-'
        && bytes[19] == b'-'
        && bytes[23] == b'Z'
}

/// Writes `document` as the user settings file, copying the previous file into the backups
/// directory first. The write is atomic (temporary file, then rename) and the temporary file
/// is created owner-readable only, as the capture's `mode: 0o600` does.
pub fn save_with_backup(
    paths: &SettingsPaths,
    document: &Value,
    at: DateTime<Utc>,
) -> Result<(), ConfigError> {
    let serialized = serde_yaml::to_string(document).map_err(ConfigError::Typed)?;

    fs::create_dir_all(&paths.backups_dir).map_err(|source| ConfigError::Write {
        path: paths.backups_dir.clone(),
        source,
    })?;
    fs::create_dir_all(&paths.config_base_dir).map_err(|source| ConfigError::Write {
        path: paths.config_base_dir.clone(),
        source,
    })?;

    if paths.settings_file.exists() {
        let backup = paths.backups_dir.join(backup_filename(at));
        fs::copy(&paths.settings_file, &backup).map_err(|source| ConfigError::Write {
            path: backup,
            source,
        })?;
    }

    let write = |temporary: &Path| -> std::io::Result<()> {
        // Created with the file's final mode, so the document is never readable by another
        // local user even for the instant before the rename (`fs::write` would create it at
        // `0666 & ~umask` and leave the chmod a window behind).
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(temporary)?;
        file.write_all(serialized.as_bytes())?;
        drop(file);
        fs::rename(temporary, &paths.settings_file)
    };

    // The name is exclusive, so a `.settings.<pid>.<n>.tmp` left behind by an interrupted save
    // of an earlier process that wore this pid must move this one to the next candidate rather
    // than fail it; the taken names are never removed, because they are not this save's.
    let mut taken: Vec<String> = Vec::new();
    for _ in 0..TEMPORARY_ATTEMPTS {
        let name = temporary_name();
        let temporary = paths.config_base_dir.join(&name);
        match write(&temporary) {
            Ok(()) => return Ok(()),
            Err(source) if source.kind() == ErrorKind::AlreadyExists => taken.push(name),
            Err(source) => {
                let _ = fs::remove_file(&temporary);
                return Err(ConfigError::Write {
                    path: paths.settings_file.clone(),
                    source,
                });
            }
        }
    }
    Err(ConfigError::Write {
        path: paths.settings_file.clone(),
        source: std::io::Error::new(
            ErrorKind::AlreadyExists,
            format!(
                "no free temporary settings file name after {TEMPORARY_ATTEMPTS} tries: {}",
                taken.join(", ")
            ),
        ),
    })
}

/// How many candidate temporary names one save tries before giving up. Small on purpose: the
/// names are exclusive, so a run of taken ones means a run of interrupted saves, not contention.
const TEMPORARY_ATTEMPTS: u64 = 5;

/// One candidate temporary file name. The counter, never the candidate's index, is what makes
/// the name this process's: a name already on disk is retried, never overwritten.
fn temporary_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        ".settings.{}.{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Appends one JSON line to the settings audit file (`appendSettingsAuditLog`).
pub fn append_audit(paths: &SettingsPaths, entry: &serde_json::Value) -> Result<(), ConfigError> {
    fs::create_dir_all(&paths.config_base_dir).map_err(|source| ConfigError::Write {
        path: paths.config_base_dir.clone(),
        source,
    })?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.audit_log)
        .map_err(|source| ConfigError::Write {
            path: paths.audit_log.clone(),
            source,
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    writeln!(file, "{entry}").map_err(|source| ConfigError::Write {
        path: paths.audit_log.clone(),
        source,
    })
}

/// The settings tree narrowed to the keys the defaults document carries, keeping a
/// `passwordHash` subtree the defaults lack (`filterSettingsAgainstDefaults`).
pub fn filter_against_defaults(settings: &Value, defaults: &Value) -> Value {
    if let Value::Sequence(items) = settings {
        let Value::Sequence(schema) = defaults else {
            return Value::Sequence(Vec::new());
        };
        if schema.is_empty() {
            return Value::Sequence(items.clone());
        }
        let item_schema = &schema[0];
        return Value::Sequence(
            items
                .iter()
                .map(|item| filter_against_defaults(item, item_schema))
                .collect(),
        );
    }

    if is_plain_object(settings) {
        if !is_plain_object(defaults) {
            return Value::Mapping(Default::default());
        }
        let (Value::Mapping(settings), Value::Mapping(defaults)) = (settings, defaults) else {
            return Value::Null;
        };
        let mut filtered = serde_yaml::Mapping::new();
        for (key, value) in settings {
            let Value::String(name) = key else {
                continue;
            };
            // `hasOwn(defaults, key) || key === 'passwordHash'` (`settings-config.ts:507-513`).
            if !defaults.contains_key(name.as_str()) && name != "passwordHash" {
                continue;
            }
            let sub_schema = defaults
                .get(name.as_str())
                .cloned()
                .unwrap_or_else(|| Value::Mapping(Default::default()));
            filtered.insert(key.clone(), filter_against_defaults(value, &sub_schema));
        }
        return Value::Mapping(filtered);
    }

    settings.clone()
}

/// Lists the backups, newest first, with the capture's `createdAt`/`sizeBytes`.
pub fn list_backups(paths: &SettingsPaths) -> Result<Vec<BackupInfo>, ConfigError> {
    let directory = &paths.backups_dir;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(directory).map_err(|source| ConfigError::Read {
        path: directory.clone(),
        source,
    })?;

    let mut backups = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| ConfigError::Read {
            path: directory.clone(),
            source,
        })?;
        let filename = entry.file_name().to_string_lossy().into_owned();
        if !is_backup_filename(&filename) {
            continue;
        }
        let metadata = entry.metadata().map_err(|source| ConfigError::Read {
            path: entry.path(),
            source,
        })?;
        let created_at: DateTime<Utc> = metadata
            .modified()
            .map_or_else(|_| DateTime::<Utc>::UNIX_EPOCH, |modified| modified.into());
        backups.push(BackupInfo {
            filename,
            created_at: created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            size_bytes: metadata.len(),
        });
    }

    backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(backups)
}

/// Reads one backup and writes it back as the user document, after validating it over the
/// defaults (`restoreSettingsBackup`).
pub fn restore_backup(
    paths: &SettingsPaths,
    defaults: &Value,
    filename: &str,
    at: DateTime<Utc>,
) -> Result<Value, ConfigError> {
    if !is_backup_filename(filename) {
        return Err(ConfigError::InvalidBackupFilename);
    }
    let backup_path = paths.backups_dir.join(filename);
    if !is_regular_file(&backup_path) {
        return Err(ConfigError::BackupNotFound);
    }

    let document = crate::load::load_document(&backup_path)?;
    if !document.is_mapping() {
        return Err(ConfigError::NotAMapping { path: backup_path });
    }

    let merged = crate::load::merge(defaults, &document);
    let issues = validate_document(&merged, defaults);
    if !issues.is_empty() {
        let paths: Vec<String> = issues.iter().map(|issue| issue.path.clone()).collect();
        return Err(ConfigError::BackupInvalid {
            paths: paths.join(", "),
        });
    }

    save_with_backup(paths, &document, at)?;
    Ok(document)
}

fn is_regular_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_backup_filename_is_the_captures() {
        let at: DateTime<Utc> = "2026-11-19T13:19:32.123Z".parse().unwrap();
        assert_eq!(
            backup_filename(at),
            "settings.2026-11-19T13-19-32-123Z.yaml"
        );
        assert!(is_backup_filename(&backup_filename(at)));
    }

    #[test]
    fn a_name_outside_the_pattern_is_refused() {
        assert!(!is_backup_filename("settings.yaml"));
        assert!(!is_backup_filename("settings.2026-11-19.yaml"));
        assert!(!is_backup_filename(
            "../settings.2026-11-19T13-19-32-123Z.yaml"
        ));
        assert!(!is_backup_filename(
            "settings.2026-11-19T13-19-32-123X.yaml"
        ));
    }

    #[test]
    fn the_defaults_filter_keeps_a_key_the_defaults_carry_and_a_password_hash() {
        // The shipped defaults carry `admin: {}` (`resources/default-settings.yaml:437`), and
        // `passwordHash` survives inside it on the capture's own rule.
        let defaults: Value = serde_yaml::from_str("a:\n  b: 1\nadmin: {}\n").unwrap();
        let settings: Value =
            serde_yaml::from_str("a:\n  b: 2\n  unknown: 3\nadmin:\n  passwordHash: x\nother: 4\n")
                .unwrap();
        let filtered = filter_against_defaults(&settings, &defaults);
        assert_eq!(filtered["a"]["b"], Value::Number(2.into()));
        assert!(filtered["a"].get("unknown").is_none());
        assert_eq!(filtered["admin"]["passwordHash"], Value::String("x".into()));
        assert!(filtered.get("other").is_none());
    }

    #[test]
    fn a_defaults_document_without_admin_drops_the_password_hash() {
        // The capture's rule is `hasOwn(defaults, key) || key === 'passwordHash'`
        // (`settings-config.ts:507-513`): with no `admin` in the defaults the whole object goes,
        // passwordHash and all. An escape for `admin` would keep it, so this case is the one that
        // tells the two rules apart.
        let defaults: Value = serde_yaml::from_str("a:\n  b: 1\n").unwrap();
        let settings: Value =
            serde_yaml::from_str("admin:\n  passwordHash: x\npasswordHash: y\n").unwrap();
        let filtered = filter_against_defaults(&settings, &defaults);
        assert!(filtered.get("admin").is_none(), "{filtered:?}");
        assert_eq!(filtered["passwordHash"], Value::String("y".into()));
    }
}
