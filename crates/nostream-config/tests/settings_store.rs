//! The settings file's own permissions, at the instant it is created.
//!
//! | case | what it proves |
//! |---|---|
//! | `the_settings_file_is_private_from_creation` | with a `022` umask the document is `0600` the moment the handle exists, so another local user never sees it |
//!
//! The case runs in a child process of its own, because `umask` is process-wide, and the one
//! that matters is the shell's. A thread watches the config directory while the save runs, so
//! the mode asserted is the mode during the write and not the mode after the rename.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use nostream_config::paths::SettingsPaths;

/// The variable that marks the child, which does the assertions.
const CHILD: &str = "NOSTREAM_SETTINGS_STORE_MODE_CHILD";

/// A document large enough that the temporary file exists, and is written to, for long enough
/// that the watcher sees it: the window the finding describes is one syscall wide on a small
/// document.
const DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

fn temporary_settings_files(directory: &Path) -> Vec<String> {
    std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with(".settings.") && name.ends_with(".tmp"))
                .collect()
        })
        .unwrap_or_default()
}

/// The mode of every temporary file the watcher saw, as it saw it.
fn observed_temporary_modes(
    directory: &Path,
    document: &serde_yaml::Value,
    paths: &SettingsPaths,
) -> Vec<u32> {
    let observed: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let watcher = {
        let directory: PathBuf = directory.to_path_buf();
        let observed = Arc::clone(&observed);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Ok(entries) = std::fs::read_dir(&directory) else {
                    continue;
                };
                for entry in entries.filter_map(|entry| entry.ok()) {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !name.starts_with(".settings.") || !name.ends_with(".tmp") {
                        continue;
                    }
                    if let Ok(metadata) = entry.metadata() {
                        let mode = metadata.permissions().mode() & 0o777;
                        observed
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .push(mode);
                    }
                }
            }
        })
    };

    nostream_config::store::save_with_backup(paths, document, chrono::Utc::now())
        .expect("the settings save");
    stop.store(true, Ordering::Relaxed);
    watcher.join().expect("the watcher");

    Arc::try_unwrap(observed)
        .expect("one owner")
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[test]
fn the_settings_file_is_private_from_creation() {
    if std::env::var_os(CHILD).is_some() {
        assert_private_from_creation();
        return;
    }

    // The shell sets the umask; the document's own mode must not depend on it.
    let executable = std::env::current_exe().expect("the test binary");
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(r#"umask 022; exec "$0" --exact the_settings_file_is_private_from_creation"#)
        .arg(&executable)
        .env(CHILD, "1")
        .output()
        .expect("the child test run");
    assert!(
        output.status.success(),
        "the child case failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_private_from_creation() {
    let temp = tempfile::tempdir().expect("a temporary directory");
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&config_dir).expect("the config directory");
    // A config directory other local users may read: the file is what has to be private.
    std::fs::set_permissions(&config_dir, std::fs::Permissions::from_mode(0o755))
        .expect("the config directory's mode");
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o755))
        .expect("the parent directory's mode");

    let paths = SettingsPaths::from_config_dir(temp.path(), &config_dir);
    let document: serde_yaml::Value =
        serde_yaml::from_str(&format!("info:\n  name: {}\n", "x".repeat(DOCUMENT_BYTES)))
            .expect("the document");

    let observed = observed_temporary_modes(&config_dir, &document, &paths);
    assert!(
        !observed.is_empty(),
        "the watcher must see the temporary file, or this case proves nothing"
    );
    let readable: Vec<String> = observed
        .iter()
        .filter(|mode| *mode & 0o077 != 0)
        .map(|mode| format!("{mode:o}"))
        .collect();
    assert_eq!(
        readable,
        Vec::<String>::new(),
        "the document was readable by another local user while it was being written, at these \
         modes as the watcher saw them: {:?}",
        observed
            .iter()
            .map(|mode| format!("{mode:o}"))
            .collect::<Vec<_>>()
    );

    let mode = std::fs::metadata(&paths.settings_file)
        .expect("the settings file")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o600,
        "the settings file must be private from creation, not made private afterwards"
    );

    assert_eq!(
        temporary_settings_files(&config_dir),
        Vec::<String>::new(),
        "a save leaves no temporary file behind"
    );

    let written = std::fs::read_to_string(&paths.settings_file).expect("the settings file");
    let parsed: serde_yaml::Value = serde_yaml::from_str(&written).expect("the written document");
    assert_eq!(
        parsed, document,
        "the save writes the document it was given"
    );
}
