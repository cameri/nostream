//! Loader behaviour: file precedence, the deep merge, and the fallback-to-defaults rule, ported
//! from `test/unit/utils/settings.spec.ts` and the precedence block of
//! `test/unit/utils/settings-config.spec.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use nostream_config::load::{load, load_user_settings, merge};
use nostream_config::path::get_by_path;
use nostream_config::SettingsPaths;
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
fn the_loader_creates_the_config_directory() {
    let config_dir = TempDir::new().expect("tempdir");
    let target = config_dir.path().join("nested").join("config");
    let user = load_user_settings(&target).expect("the directory is created");
    assert!(user.is_none());
    assert!(target.is_dir());
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
        outcome.settings.info.relay_url,
        "wss://nostream.your-domain.com",
        "unmentioned fields keep their defaults"
    );
    assert_eq!(
        outcome.settings.nip43.and_then(|nip43| Some(nip43.enabled)),
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
    assert!(outcome.issues[0].message.contains("failed to load user settings"));
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
    write(config_dir.path(), "settings.yaml", "info:\n  name: current\n");

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
    assert_eq!(resolved.settings_file, config_dir.path().join("settings.yaml"));
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
