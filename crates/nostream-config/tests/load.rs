//! Loader behaviour: file precedence, the deep merge, and the fallback-to-defaults rule, ported
//! from `test/unit/utils/settings.spec.ts` and the precedence block of
//! `test/unit/utils/settings-config.spec.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use nostream_config::load::{fit, load, load_user_settings, merge};
use nostream_config::path::get_by_path;
use nostream_config::{ConfigError, SettingsPaths, load_defaults, validate_document};
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

#[test]
fn a_fractional_integer_field_is_refused_by_validation_and_by_the_daemon_alike() {
    // R8's agreement rule, and the finding that produced it: `period` is a JavaScript number
    // to the capture's validator (positive, therefore fine) and a `u64` to the typed schema,
    // so approving on the walk alone let `config validate` bless a document the daemon then
    // rejected — replacing the operator's whole configuration with the shipped defaults.
    let config_dir = TempDir::new().expect("tempdir");
    write(
        config_dir.path(),
        "settings.yaml",
        "limits:\n  event:\n    pow:\n      periodMs: 1000.5\n",
    );
    let settings_paths = paths(config_dir.path());

    // Path 1, the daemon's: `load` reports the field and substitutes the defaults.
    let outcome = load(&settings_paths).expect("the loader never refuses");
    assert!(outcome.used_defaults);
    assert_eq!(
        outcome
            .issues
            .iter()
            .map(|issue| issue.to_string())
            .collect::<Vec<_>>(),
        vec!["limits.event.pow.periodMs: must be a whole number"],
    );

    // Path 2, `config validate`'s: the document walk on its own still approves (it mirrors
    // the capture), and `fit` — which the CLI now runs — rejects the same document at the
    // same field, so the two paths agree.
    let defaults = load_defaults(&settings_paths.default_settings_file).expect("defaults");
    let user = load_user_settings(config_dir.path())
        .expect("read")
        .expect("present");
    let merged = merge(&defaults, &user);
    assert_eq!(validate_document(&merged, &defaults), Vec::new());
    let issue = fit(&merged, &defaults).expect_err("the typed schema refuses");
    assert_eq!(
        issue.to_string(),
        "limits.event.pow.periodMs: must be a whole number"
    );
}

#[test]
fn a_fractional_rate_blames_the_period_not_the_rate() {
    // `targetEventsPerSecond` is an `f64` and `periodMs` a `u64`, and the walk reads the
    // field's type off the serialized projection - where `serialize_js_number` writes the
    // default rate `50` as the integer `50`, because JavaScript has one number type. So the
    // valid rate was taken for an integer field and named first, sending the operator to a
    // setting that is fine while the bad period went unreported.
    let defaults: Value =
        load_defaults(&repo_root().join("resources/default-settings.yaml")).expect("defaults");
    let merged = merge(
        &defaults,
        &serde_yaml::from_str::<Value>("limits:\n  event:\n    pow:\n      targetEventsPerSecond: 10.5\n      periodMs: 1000.5\n")
            .expect("document"),
    );
    assert_eq!(validate_document(&merged, &defaults), Vec::new());
    let issue = fit(&merged, &defaults).expect_err("the typed schema refuses");
    assert_eq!(
        issue.to_string(),
        "limits.event.pow.periodMs: must be a whole number"
    );
}

#[test]
fn a_fractional_difficulty_factor_is_not_mistaken_for_an_integer_field() {
    // `difficultyFactor` is an `f64` inside a list, and `serialize_js_number` writes a `0`
    // default as the integer `0` - so the element type has to survive the walk too, not just
    // the top-level scalars.
    let defaults: Value =
        load_defaults(&repo_root().join("resources/default-settings.yaml")).expect("defaults");
    let merged = merge(
        &defaults,
        &serde_yaml::from_str::<Value>(
            "limits:\n  event:\n    pow:\n      targetEventsPerSecond: 10.5\n      wotThresholds:\n        - maxDistance: 1\n          difficultyFactor: 0.25\n",
        )
        .expect("document"),
    );
    assert_eq!(validate_document(&merged, &defaults), Vec::new());
    let settings = fit(&merged, &defaults).expect("a fractional factor and rate both fit");
    let pow = settings
        .limits
        .expect("limits")
        .event
        .expect("event limits")
        .pow
        .expect("pow");
    assert_eq!(pow.target_events_per_second, 10.5);
    assert_eq!(
        pow.wot_thresholds.expect("thresholds")[0].difficulty_factor,
        0.25
    );
}

#[test]
fn a_fractional_rate_is_accepted() {
    // The other half of the same confusion: a legitimate `f64` value must not be refused,
    // and only the explicit `f64` leaves say so once the projection writes it as an integer.
    let defaults: Value =
        load_defaults(&repo_root().join("resources/default-settings.yaml")).expect("defaults");
    let merged = merge(
        &defaults,
        &serde_yaml::from_str::<Value>(
            "limits:\n  event:\n    pow:\n      targetEventsPerSecond: 10.5\n",
        )
        .expect("document"),
    );
    assert_eq!(validate_document(&merged, &defaults), Vec::new());
    let settings = fit(&merged, &defaults).expect("a fractional rate fits");
    assert_eq!(
        settings
            .limits
            .expect("limits")
            .event
            .expect("event limits")
            .pow
            .expect("pow")
            .target_events_per_second,
        10.5
    );
}

#[test]
fn a_negative_integer_field_names_the_field() {
    // No semantic rule covers `workers.count`, so the document walk is silent and only the
    // typed fit can refuse it — which is the point: the field is named rather than the whole
    // document being reported at `$`.
    let defaults: Value =
        load_defaults(&repo_root().join("resources/default-settings.yaml")).expect("defaults");
    let merged = merge(
        &defaults,
        &serde_yaml::from_str::<Value>("workers:\n  count: -1\n").expect("document"),
    );
    assert_eq!(validate_document(&merged, &defaults), Vec::new());
    let issue = fit(&merged, &defaults).expect_err("the typed schema refuses");
    assert_eq!(issue.to_string(), "workers.count: must not be negative");
}

#[test]
fn a_settings_yaml_directory_is_a_finding_not_absence() {
    // `is_file()` used to answer false here, so the loader fell through to the deprecated
    // `settings.json` or the defaults and `--check` reported a clean config while the
    // operator's real file was unusable.
    let config_dir = TempDir::new().expect("tempdir");
    fs::create_dir(config_dir.path().join("settings.yaml")).expect("a directory at the path");

    let error = load_user_settings(config_dir.path()).expect_err("a directory is reported");
    assert!(matches!(error, ConfigError::NotAFile { .. }));
    assert!(error.to_string().contains("not a regular file"));

    let outcome = load(&paths(config_dir.path())).expect("the defaults still load");
    assert!(outcome.used_defaults);
    assert_eq!(outcome.issues.len(), 1);
    assert_eq!(outcome.issues[0].path, "$");
    assert!(outcome.issues[0].message.contains("settings.yaml"));
}

#[test]
fn a_legacy_json_directory_is_reported_the_same_way() {
    let config_dir = TempDir::new().expect("tempdir");
    fs::create_dir(config_dir.path().join("settings.json")).expect("a directory at the path");

    let error = load_user_settings(config_dir.path()).expect_err("a directory is reported");
    assert!(matches!(error, ConfigError::NotAFile { .. }));
}

#[test]
fn every_float_field_is_declared_to_the_numeric_walk() {
    // The walk reads a field's type off the serialized defaults, where `serialize_js_number`
    // has already turned an integral `f64` into an integer - so a new `f64` that does not
    // join `FLOAT_FIELDS` is silently treated as an integer field, and a valid fractional
    // value beside it is what gets blamed. This is the list's only guard: the schema cannot
    // be asked for the types, because the document has none.
    let defaults: Value =
        load_defaults(&repo_root().join("resources/default-settings.yaml")).expect("defaults");
    // A path the shipped defaults do not carry cannot be checked here - `wotThresholds` is
    // absent, so its element type rests on the list alone. Those paths are named, not skipped
    // silently, so the gap is visible instead of reading as coverage.
    let unverified: Vec<_> = nostream_config::settings::FLOAT_FIELDS
        .iter()
        .filter(|path| resolve(&defaults, path).is_none())
        .collect();
    assert_eq!(
        unverified,
        vec![&"limits.event.pow.wotThresholds[].difficultyFactor"],
        "an unreachable FLOAT_FIELDS path is a stale entry, and a newly added one has no default to check against"
    );
    assert_eq!(
        nostream_config::settings::FLOAT_FIELDS.len(),
        2,
        "a new `f64` field in `settings.rs` needs a path in `FLOAT_FIELDS` and this count"
    );
}

/// Resolves a dotted path whose `[]` segment means "the first element", the same convention
/// `FLOAT_FIELDS` uses.
fn resolve<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(value, |node, segment| {
        let (key, element) = match segment.strip_suffix("[]") {
            Some(key) => (key, true),
            None => (segment, false),
        };
        let node = node.get(key)?;
        if element {
            node.as_sequence().and_then(|sequence| sequence.first())
        } else {
            Some(node)
        }
    })
}
