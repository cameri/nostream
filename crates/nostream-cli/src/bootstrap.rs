//! The bootstrap steps `start` and `setup` run before anything else: the config directory and
//! its settings file, the Tor and I2P data directories, and the two paths those data live at.
//!
//! Mirrors `src/cli/utils/bootstrap.ts` and the capture's `getProjectPath`, which resolves
//! against the **working directory** — so `nginx/`, `.nostr/` and `.env.example` are the ones
//! under the directory the operator ran the binary from, not under the binary.

use std::path::{Path, PathBuf};

use crate::config::resolve_paths;
use crate::env_file::Environment;
use crate::error::CliError;

/// The working directory's path to `parts` (`getProjectPath`).
pub fn project_path(cwd: &Path, parts: &[&str]) -> PathBuf {
    let mut path = cwd.to_path_buf();
    for part in parts {
        path.push(part);
    }
    path
}

/// `ensureNotRoot`: refuses to run as uid 0, because a compose stack started as root owns files
/// the operator cannot then change afterwards.
///
/// The uid is read the way every other probe reads its subject — a child through
/// `nostream_services::process`, because this crate opens no processes of its own
/// (`CLAUDE.md:116`). A host without `id` cannot answer, and the check then declines to refuse:
/// the capture's own guard is `typeof process.geteuid === 'function'`, which is exactly a check
/// that stays silent where the platform cannot speak.
pub async fn ensure_not_root() -> Result<(), CliError> {
    let argv = ["id".to_owned(), "-u".to_owned()];
    match nostream_services::process::capture(&argv, None).await {
        nostream_services::process::CapturedResult::Exited {
            code: 0, stdout, ..
        } if stdout.trim() == "0" => Err(CliError::command("Nostream should not be run as root.")),
        _ => Ok(()),
    }
}

/// `ensureConfigBootstrap`: the config directory, and `settings.yaml` copied from the defaults
/// when neither it nor the deprecated `settings.json` is there.
///
/// The legacy check is not the capture's: `src/cli/utils/bootstrap.ts` tests only
/// `settings.yaml`, so `start` copies the defaults over a deployment that still keeps its
/// overrides in `settings.json` — and because the loader prefers `settings.yaml`
/// (`nostream_config::load_user_settings`), every override in the legacy file is silently
/// replaced by a default on the next start. Testing both files keeps that deployment effective
/// and leaves the migration of `settings.json` to `settings.yaml` to the operator.
pub fn ensure_config_bootstrap(cwd: &Path, env: &Environment) -> Result<(), CliError> {
    let paths = resolve_paths(cwd, None, env);

    std::fs::create_dir_all(&paths.config_base_dir).map_err(|error| {
        CliError::command(format!(
            "unable to create {}: {error}",
            paths.config_base_dir.display()
        ))
    })?;

    if !paths.settings_file.exists() && !paths.legacy_settings_file.exists() {
        if !paths.default_settings_file.exists() {
            return Err(CliError::command(format!(
                "the default settings file is missing: {}",
                paths.default_settings_file.display()
            )));
        }
        std::fs::copy(&paths.default_settings_file, &paths.settings_file).map_err(|error| {
            CliError::command(format!(
                "unable to write {}: {error}",
                paths.settings_file.display()
            ))
        })?;
    }

    Ok(())
}

/// The Tor data directory a `--tor` run needs.
pub fn ensure_tor_data_dir(cwd: &Path) -> Result<(), CliError> {
    let path = project_path(cwd, &[".nostr", "tor", "data"]);
    std::fs::create_dir_all(&path)
        .map_err(|error| CliError::command(format!("unable to create {}: {error}", path.display())))
}

/// The I2P data directory an `--i2p` run needs.
pub fn ensure_i2p_data_dir(cwd: &Path) -> Result<(), CliError> {
    let path = project_path(cwd, &[".nostr", "i2p", "data"]);
    std::fs::create_dir_all(&path)
        .map_err(|error| CliError::command(format!("unable to create {}: {error}", path.display())))
}

/// The file the Tor hidden service publishes its `.onion` name in (`getTorHostnamePath`).
pub fn tor_hostname_path(cwd: &Path) -> PathBuf {
    project_path(cwd, &[".nostr", "tor", "data", "nostream", "hostname"])
}

/// The i2pd destination keys file (`info.ts:180`).
pub fn i2p_keys_path(cwd: &Path) -> PathBuf {
    project_path(cwd, &[".nostr", "i2p", "data", "nostream.dat"])
}

/// The directory the settings live in, as the process environment names it
/// (`NOSTR_CONFIG_DIR`, else `<cwd>/.nostr`).
pub fn config_dir(cwd: &Path, env: &crate::env_file::Environment) -> PathBuf {
    match env.get("NOSTR_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => cwd.join(".nostr"),
    }
}

/// `getOnionKeyPath`: `<NOSTR_CONFIG_DIR>/v3_onion_private_key`, else `<home>/.nostr/…`.
pub fn onion_key_path(cwd: &Path, env: &crate::env_file::Environment) -> PathBuf {
    match env.get("NOSTR_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir).join("v3_onion_private_key"),
        None => home_dir()
            .unwrap_or_else(|| cwd.to_path_buf())
            .join(".nostr")
            .join("v3_onion_private_key"),
    }
}

/// `os.homedir()`: `$HOME` on Unix, `$USERPROFILE` on Windows.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}
