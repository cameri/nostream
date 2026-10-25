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
