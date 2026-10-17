//! Loader behaviour: file precedence, the deep merge, and the fallback-to-defaults rule, ported
//! from `test/unit/utils/settings.spec.ts` and the precedence block of
//! `test/unit/utils/settings-config.spec.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use nostream_config::SettingsPaths;
use nostream_config::load::{load, load_user_settings, merge};
use nostream_config::path::get_by_path;
use serde_yaml::Value;
use tempfile::TempDir;

fn repo_root() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn paths(config_dir: &Path) -> SettingsPaths {
    SettingsPaths::from_config_dir(repo_root(), config_dir)
}

fn write(config_dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = config_dir.join(name);
    fs::write(&path, contents).expect("the test writes its fixture");
    path
}

#[test]
fn the_shipped_defaults_load_clean() {
    let config_dir = TempDir::new().expect("tempdir");
    let outcome = load(&paths(config_dir.path())).expect("the defaults load");

    assert_eq!(outcome.issues, Vec::new());
    assert!(!outcome.used_defaults);
    assert_eq!(outcome.settings.info.name, "nostream.your-domain.com");
    assert_eq!(
        outcome.settings.info.relay_url,
        "wss://nostream.your-domain.com"
    );
}

#[test]
fn the_loader_does_not_create_the_config_directory() {
    // The read probe is read-only: `nostreamd --check` on a fresh host must not materialise
    // `.nostr/`. Directory creation belongs to the mutating callers (the guided editor, the
    // save path).
    let config_dir = TempDir::new().expect("tempdir");
    let target = config_dir.path().join("nested").join("config");
    let user = load_user_settings(&target).expect("an absent directory is not an error");
    assert!(user.is_none());
    assert!(!target.exists());
}

#[test]
fn a_yaml_override_is_deep_merged() {
    let config_dir = TempDir::new().expect("tempdir");
    write(
        config_dir.path(),
        "settings.yaml",
        "info:\n  name: my-relay\nnip43:\n  enabled: true\n",
    );
    let outcome = load(&paths(config_dir.path())).expect("the settings load");

    assert_eq!(outcome.issues, Vec::new());
    assert!(!outcome.used_defaults);
    assert_eq!(outcome.settings.info.name, "my-relay");
    assert_eq!(
        outcome.settings.info.relay_url, "wss://nostream.your-domain.com",
        "unmentioned fields keep their defaults"
    );
    assert_eq!(
        outcome.settings.nip43.map(|nip43| nip43.enabled),
        Some(true)
    );
}

#[test]
fn an_invalid_override_falls_back_to_the_defaults_and_reports_the_issues() {
    let config_dir = TempDir::new().expect("tempdir");
    write(
        config_dir.path(),
        "settings.yaml",
        "limits:\n  rateLimiter:\n    strategy: random\n",
    );
    let outcome = load(&paths(config_dir.path())).expect("the settings load");

    assert!(outcome.used_defaults);
    assert_eq!(
        outcome
            .issues
            .iter()
            .map(|issue| issue.to_string())
            .collect::<Vec<_>>(),
        vec!["limits.rateLimiter.strategy: strategy must be ewma or sliding_window"]
    );
    assert_eq!(
        outcome.settings.info.name, "nostream.your-domain.com",
        "the fallback is the typed defaults, not the user's document"
    );
}

#[test]
fn a_broken_yaml_file_falls_back_with_an_issue() {
    let config_dir = TempDir::new().expect("tempdir");
    write(config_dir.path(), "settings.yaml", "info: [unclosed\n");
    let outcome = load(&paths(config_dir.path())).expect("the defaults still load");

    assert!(outcome.used_defaults);
    assert_eq!(outcome.issues.len(), 1);
    assert_eq!(outcome.issues[0].path, "$");
    assert!(
        outcome.issues[0]
            .message
            .contains("failed to load user settings")
    );
}

#[test]
fn the_deprecated_json_file_is_read_when_yaml_is_absent() {
    let config_dir = TempDir::new().expect("tempdir");
    write(
        config_dir.path(),
        "settings.json",
        "{\"info\": {\"name\": \"legacy\"}}",
    );
    let user = load_user_settings(config_dir.path())
        .expect("the legacy file loads")
        .expect("an override exists");
    assert_eq!(
        get_by_path(&user, "info.name").expect("path").cloned(),
        Some(Value::String("legacy".to_owned()))
    );
}

#[test]
fn yaml_takes_precedence_over_the_deprecated_json_file() {
    let config_dir = TempDir::new().expect("tempdir");
    write(
        config_dir.path(),
        "settings.json",
        "{\"info\": {\"name\": \"legacy\"}}",
    );
    write(
        config_dir.path(),
        "settings.yaml",
        "info:\n  name: current\n",
    );

    let user = load_user_settings(config_dir.path())
        .expect("the file loads")
        .expect("an override exists");
    assert_eq!(
        get_by_path(&user, "info.name").expect("path").cloned(),
        Some(Value::String("current".to_owned()))
    );
}

#[test]
fn an_empty_yaml_file_is_an_empty_override_set() {
    let config_dir = TempDir::new().expect("tempdir");
    write(config_dir.path(), "settings.yaml", "");
    let user = load_user_settings(config_dir.path()).expect("the file loads");
    assert_eq!(user, Some(Value::Mapping(serde_yaml::Mapping::new())));
}

#[test]
fn merge_replaces_arrays_and_keeps_untouched_keys() {
    let defaults: Value =
        serde_yaml::from_str("a:\n  b: 1\n  list:\n    - 1\n    - 2\n").expect("doc");
    let user: Value = serde_yaml::from_str("a:\n  list:\n    - 9\n").expect("doc");
    let merged = merge(&defaults, &user);
    assert_eq!(
        get_by_path(&merged, "a.list").expect("path").cloned(),
        Some(serde_yaml::from_str::<Value>("[9]").expect("seq"))
    );
    assert_eq!(
        get_by_path(&merged, "a.b").expect("path").cloned(),
        Some(Value::Number(1.into()))
    );
}

#[test]
fn a_config_dir_override_wins_over_the_environment() {
    let config_dir = TempDir::new().expect("tempdir");
    let resolved = SettingsPaths::from_config_dir(Path::new("/srv/relay"), config_dir.path());
    assert_eq!(resolved.config_base_dir, config_dir.path());
    assert_eq!(
        resolved.settings_file,
        config_dir.path().join("settings.yaml")
    );
    assert_eq!(
        resolved.legacy_settings_file,
        config_dir.path().join("settings.json")
    );
    assert_eq!(resolved.backups_dir, config_dir.path().join("backups"));
    assert_eq!(
        resolved.audit_log,
        config_dir.path().join("settings-audit.jsonl")
    );
    assert_eq!(
        resolved.default_settings_file,
        Path::new("/srv/relay")
            .join("resources")
            .join("default-settings.yaml")
    );
}

#[test]
fn a_config_path_that_is_a_file_is_a_finding_not_silence() {
    // Round 3 item 5: a location that exists but is not a directory must warn and fall
    // back, exactly like any other unreadable user configuration.
    let outer = TempDir::new().expect("tempdir");
    let impostor = outer.path().join("impostor");
    std::fs::write(&impostor, "not a directory").expect("write the file");

    let outcome = load(&paths(&impostor)).expect("the loader never refuses");
    assert!(outcome.used_defaults);
    assert_eq!(outcome.issues.len(), 1);
    assert!(outcome.issues[0].to_string().contains("not a directory"));
}

#[test]
fn a_dangling_config_symlink_is_a_finding_not_silence() {
    // Round 4 item 1: `Path::exists` follows links, so a dangling `--config-dir` link used
    // to fall through to `Ok(None)` and `--check` printed a clean bill.
    let outer = TempDir::new().expect("tempdir");
    let link = outer.path().join("dangling");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outer.path().join("never-created"), &link)
        .expect("create the dangling link");

    let outcome = load(&paths(&link)).expect("the loader never refuses");
    assert!(outcome.used_defaults);
    assert_eq!(outcome.issues.len(), 1);
    assert!(outcome.issues[0].to_string().contains("not a directory"));
}

#[test]
fn a_config_dir_behind_an_unreadable_parent_is_a_finding() {
    // A stat error on the path itself (here: a parent that is a file, EACCES/ENOTDIR on
    // most systems) is a sibling finding, not silent absence.
    let outer = TempDir::new().expect("tempdir");
    let file_parent = outer.path().join("a-file");
    std::fs::write(&file_parent, "x").expect("write");
    let beneath = file_parent.join("settings");

    let outcome = load(&paths(&beneath)).expect("the loader never refuses");
    assert!(outcome.used_defaults);
    assert_eq!(outcome.issues.len(), 1);
}

#[test]
fn a_symlink_to_a_real_directory_is_accepted() {
    // Round 5 regression: the round-4 probe used lstat, which does not resolve the final
    // component, so a config dir that is a symlink to a real directory — a location the
    // capture accepts (existsSync follows links) — substituted the defaults. (Fails
    // against 1be80b2.)
    let outer = TempDir::new().expect("tempdir");
    let real = outer.path().join("real-config");
    std::fs::create_dir_all(&real).expect("create the real directory");
    std::fs::write(real.join("settings.yaml"), "info:\n  name: linked-relay\n")
        .expect("write the override");

    let link = outer.path().join("config-link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &link).expect("create the link");
    #[cfg(not(unix))]
    std::os::windows::fs::symlink_dir(&real, &link).expect("create the link");

    let outcome = load(&paths(&link)).expect("the loader never refuses");
    assert!(!outcome.used_defaults, "the symlinked dir must load");
    assert!(outcome.issues.is_empty());
    assert_eq!(outcome.settings.info.name, "linked-relay");
}

#[test]
fn a_dangling_link_with_a_trailing_separator_is_a_finding() {
    // POSIX resolves a trailing slash through the link, so `…/link/` on a dangling link
    // stats as ENOENT; the probe trims the separators so the second probe sees the link
    // entry and reports the finding instead of silence.
    let outer = TempDir::new().expect("tempdir");
    let link = outer.path().join("dangling");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outer.path().join("never-created"), &link)
        .expect("create the dangling link");

    let with_separator = PathBuf::from(format!("{}/", link.display()));
    let outcome = load(&paths(&with_separator)).expect("the loader never refuses");
    assert!(outcome.used_defaults);
    assert_eq!(outcome.issues.len(), 1);
    assert!(outcome.issues[0].to_string().contains("not a directory"));
}

#[test]
fn an_absent_config_dir_with_a_trailing_separator_is_clean_absence() {
    // Round 6: the old trim used Path::parent, so `/srv/relay/config/` landed on
    // `/srv/relay` — a real directory — and produced a bogus NotADirectory finding on a
    // fresh host. The trim must remove the separator bytes, not the component. (Fails
    // against bb659c0.)
    let outer = TempDir::new().expect("tempdir");
    let absent = outer.path().join("never-created");
    let with_separator = PathBuf::from(format!("{}/", absent.display()));

    let outcome = load(&paths(&with_separator)).expect("the loader never refuses");
    assert!(!outcome.used_defaults, "clean absence is not a fallback");
    assert!(outcome.issues.is_empty());
}

#[test]
fn a_relative_single_component_dangling_link_with_a_trailing_separator_is_a_finding() {
    // The other measured consequence: `dangling/` trimmed to `""` under Path::parent, and
    // lstat on "" is ENOENT, which took Ok(None) — silent absence where the comment
    // promises a finding. (Fails against bb659c0.)
    let outer = TempDir::new().expect("tempdir");
    let previous = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(outer.path()).expect("chdir into the tempdir");

    #[cfg(unix)]
    std::os::unix::fs::symlink("never-created", "dangling").expect("create the link");

    let outcome = load(&paths(Path::new("dangling/")));
    std::env::set_current_dir(previous).expect("restore the cwd");

    let outcome = outcome.expect("the loader never refuses");
    assert!(outcome.used_defaults);
    assert_eq!(outcome.issues.len(), 1);
    assert!(outcome.issues[0].to_string().contains("not a directory"));
}
