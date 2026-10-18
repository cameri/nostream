//! Where the settings files live. Mirrors `src/utils/settings-paths.ts` exactly.

use std::path::{Path, PathBuf};

/// The resolved settings paths for one process.
///
/// `config_base_dir` is `NOSTR_CONFIG_DIR` when set, else `<cwd>/.nostr`. `default_settings_file`
/// is `<cwd>/resources/default-settings.yaml`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsPaths {
    pub config_base_dir: PathBuf,
    pub settings_file: PathBuf,
    pub legacy_settings_file: PathBuf,
    pub default_settings_file: PathBuf,
    pub backups_dir: PathBuf,
    pub audit_log: PathBuf,
}

impl SettingsPaths {
    /// Resolves the paths from the process environment and the given working directory.
    pub fn resolve(cwd: &Path) -> Self {
        let base = match std::env::var_os("NOSTR_CONFIG_DIR") {
            Some(value) => PathBuf::from(value),
            None => cwd.join(".nostr"),
        };
        Self::from_config_dir(cwd, base)
    }

    /// Resolves the paths from an explicit config directory (the CLI's `--config-dir`).
    pub fn from_config_dir(cwd: &Path, config_base_dir: impl Into<PathBuf>) -> Self {
        let config_base_dir = config_base_dir.into();
        Self {
            settings_file: config_base_dir.join("settings.yaml"),
            legacy_settings_file: config_base_dir.join("settings.json"),
            default_settings_file: cwd.join("resources").join("default-settings.yaml"),
            backups_dir: config_base_dir.join("backups"),
            audit_log: config_base_dir.join("settings-audit.jsonl"),
            config_base_dir,
        }
    }
}
