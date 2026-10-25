//! A malformed user settings file must serve on the defaults, not abort (R7's fallback rule).

// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::PathBuf;

use nostream_config::SettingsPaths;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .canonicalize()
        .expect("the workspace root exists")
}

#[test]
fn a_malformed_user_file_loads_the_defaults_with_findings() {
    let directory = tempfile::tempdir().expect("tempdir");
    fs::write(
        directory.path().join("settings.yaml"),
        "limits:\n  rateLimiter:\n    strategy: random\n",
    )
    .expect("write");

    let paths = SettingsPaths::from_config_dir(&workspace_root(), directory.path());
    let outcome = nostream_config::load(&paths).expect("the loader never refuses");

    assert!(outcome.used_defaults, "the defaults substitute");
    assert!(!outcome.issues.is_empty(), "the findings are reported");

    // The gate on the serve path (check=false): findings logged, no error.
    nostreamd::settings_gate::apply_settings_gate(&outcome, false).expect("serve continues");

    // The gate on the check path (check=true): findings are fatal.
    let error = nostreamd::settings_gate::apply_settings_gate(&outcome, true)
        .expect_err("check refuses an invalid document");
    assert!(matches!(
        error,
        nostreamd::DaemonError::InvalidSettings { count: 1 }
    ));
}

#[test]
fn a_zero_bound_is_an_issue_at_the_gate() {
    // A zero bound is a validator issue like any other, so it reaches the gate as one: the serve
    // path continues on the shipped defaults, the check path refuses it (#996, ADR 0008). The
    // document is otherwise valid, so the count is the bound's issue alone and there is no
    // operator value left for `refused_bounds` to describe.
    let directory = tempfile::tempdir().expect("tempdir");
    fs::write(
        directory.path().join("settings.yaml"),
        "network:\n  frameMemoryBudgetBytes: 0\n",
    )
    .expect("write");

    let paths = SettingsPaths::from_config_dir(&workspace_root(), directory.path());
    let outcome = nostream_config::load(&paths).expect("the loader never refuses");

    assert!(outcome.used_defaults, "the defaults substitute");
    assert_eq!(
        outcome
            .issues
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["network.frameMemoryBudgetBytes: frameMemoryBudgetBytes must be greater than 0"],
        "the zero is the whole finding"
    );

    // The gate on the serve path (check=false): the finding is reported, no error.
    nostreamd::settings_gate::apply_settings_gate(&outcome, false).expect("serve continues");

    // The gate on the check path (check=true): the finding is fatal.
    let error = nostreamd::settings_gate::apply_settings_gate(&outcome, true)
        .expect_err("check refuses a zero bound");
    assert!(matches!(
        error,
        nostreamd::DaemonError::InvalidSettings { count: 1 }
    ));
}

#[test]
fn a_clean_document_passes_the_gate_both_ways() {
    let directory = tempfile::tempdir().expect("tempdir"); // empty config dir: no overrides
    let paths = SettingsPaths::from_config_dir(&workspace_root(), directory.path());
    let outcome = nostream_config::load(&paths).expect("load");
    assert!(!outcome.used_defaults);
    assert!(outcome.issues.is_empty());
    nostreamd::settings_gate::apply_settings_gate(&outcome, true).expect("check passes");
}
