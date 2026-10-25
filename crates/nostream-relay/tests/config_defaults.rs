//! `RelayConfig::default()` and the shipped defaults document must state the same two bounds.
//! The document is what an operator reads and edits; the compiled default is what a relay runs
//! on when the key is absent. A divergence is silent in both directions, so it is asserted here
//! rather than left to whichever of the two a reader happens to open (ADR 0008, #989).

// This integration-test target may unwrap and panic: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use nostream_config::settings::Settings;
use nostream_relay::relay::RelayConfig;

fn defaults_settings() -> Settings {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/default-settings.yaml");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "the shipped defaults {} are readable: {error}",
            path.display()
        )
    });
    serde_yaml::from_str(&raw).expect("the shipped defaults are valid YAML")
}

#[test]
fn the_compiled_bounds_equal_the_shipped_defaults() {
    let shipped = defaults_settings();
    let config = RelayConfig::default();

    let budget = shipped
        .network
        .frame_memory_budget_bytes
        .expect("the shipped defaults carry network.frameMemoryBudgetBytes");
    let cap = shipped
        .limits
        .as_ref()
        .and_then(|limits| limits.connection.as_ref())
        .and_then(|connection| connection.max_connections_per_ip)
        .expect("the shipped defaults carry limits.connection.maxConnectionsPerIp");

    assert_eq!(
        config.frame_memory_budget_bytes as u64, budget,
        "network.frameMemoryBudgetBytes is {budget} in the defaults document and \
         {} in RelayConfig::default()",
        config.frame_memory_budget_bytes
    );
    assert_eq!(
        config.max_connections_per_ip as u64, cap,
        "limits.connection.maxConnectionsPerIp is {cap} in the defaults document and \
         {} in RelayConfig::default()",
        config.max_connections_per_ip
    );
}

/// A `Settings` whose two bounds are whatever the caller asks for — `None` for a key the operator
/// did not write. Everything else is the shipped defaults, so a difference in the result can only
/// come from the two leaves.
fn settings_with_bounds(budget: Option<u64>, cap: Option<u64>) -> Settings {
    let mut settings = defaults_settings();
    settings.network.frame_memory_budget_bytes = budget;
    settings
        .limits
        .as_mut()
        .and_then(|limits| limits.connection.as_mut())
        .expect("the shipped defaults carry limits.connection")
        .max_connections_per_ip = cap;
    settings
}

#[test]
fn a_non_default_setting_is_the_value_the_relay_runs_with() {
    // The behaviour #989 exists for: what the operator wrote is what the relay gets. Asserted by
    // value on both bounds, because "differs from the default" passes when the constructor swaps
    // one number for the other.
    let config = RelayConfig::from_settings(&settings_with_bounds(Some(1_234), Some(7)));
    let defaults = RelayConfig::default();

    assert_eq!(config.frame_memory_budget_bytes, 1_234);
    assert_eq!(config.max_connections_per_ip, 7);
    assert_eq!(
        config.frame_queue_bytes, defaults.frame_queue_bytes,
        "the settings must not change any other field"
    );
    assert_eq!(config.write_timeout, defaults.write_timeout);
    assert_eq!(config.liveness_interval, defaults.liveness_interval);
    assert_eq!(config.drain_timeout, defaults.drain_timeout);
}

#[test]
fn a_setting_above_the_ceiling_falls_back_to_the_compiled_default() {
    // `usize::MAX` is a `usize`, so a bare `> 0` check would pass it to `FrameBudget::admit`,
    // whose guard cannot trip and whose accounting adds unchecked.
    let config = RelayConfig::from_settings(&settings_with_bounds(Some(u64::MAX), Some(u64::MAX)));
    let defaults = RelayConfig::default();

    assert_eq!(
        config.frame_memory_budget_bytes,
        defaults.frame_memory_budget_bytes
    );
    assert_eq!(
        config.max_connections_per_ip,
        defaults.max_connections_per_ip
    );

    // The documented ceiling is accepted; one byte over it is not. Spelled out here rather than
    // imported, so lowering the constant cannot quietly lower this test with it.
    let ceiling = 1024 * 1024 * 1024 * 1024_usize;
    let at_ceiling = RelayConfig::from_settings(&settings_with_bounds(
        Some(ceiling as u64),
        Some(ceiling as u64),
    ));
    assert_eq!(at_ceiling.frame_memory_budget_bytes, ceiling);
    assert_eq!(at_ceiling.max_connections_per_ip, ceiling);

    let over = RelayConfig::from_settings(&settings_with_bounds(
        Some(ceiling as u64 + 1),
        Some(ceiling as u64 + 1),
    ));
    assert_eq!(
        over.frame_memory_budget_bytes,
        defaults.frame_memory_budget_bytes
    );
    assert_eq!(over.max_connections_per_ip, defaults.max_connections_per_ip);
}

#[test]
fn absent_sections_fall_back_to_the_compiled_default() {
    // Not just absent leaves: an operator file may omit `limits` entirely, or `limits` without
    // `connection`, and the two-level `and_then` chain must survive both.
    let mut without_limits = defaults_settings();
    without_limits.limits = None;

    let mut without_connection = defaults_settings();
    without_connection
        .limits
        .as_mut()
        .expect("the shipped defaults carry limits")
        .connection = None;

    for settings in [without_limits, without_connection] {
        let config = RelayConfig::from_settings(&settings);
        assert_eq!(
            config.max_connections_per_ip,
            RelayConfig::default().max_connections_per_ip
        );
    }
}

#[test]
fn a_zero_setting_falls_back_to_the_compiled_default() {
    // The answer ADR 0008's `What 0 means` gives, for each bound on its own so a constructor that
    // read only one leaf cannot pass both cases.
    let budget_only = RelayConfig::from_settings(&settings_with_bounds(Some(0), Some(7)));
    assert_eq!(
        budget_only.frame_memory_budget_bytes,
        RelayConfig::default().frame_memory_budget_bytes
    );
    assert_eq!(budget_only.max_connections_per_ip, 7);

    let cap_only = RelayConfig::from_settings(&settings_with_bounds(Some(1_234), Some(0)));
    assert_eq!(cap_only.frame_memory_budget_bytes, 1_234);
    assert_eq!(
        cap_only.max_connections_per_ip,
        RelayConfig::default().max_connections_per_ip
    );
}

#[test]
fn an_absent_setting_falls_back_to_the_compiled_default() {
    let config = RelayConfig::from_settings(&settings_with_bounds(None, None));
    let defaults = RelayConfig::default();

    assert_eq!(
        config.frame_memory_budget_bytes,
        defaults.frame_memory_budget_bytes
    );
    assert_eq!(
        config.max_connections_per_ip,
        defaults.max_connections_per_ip
    );
}
