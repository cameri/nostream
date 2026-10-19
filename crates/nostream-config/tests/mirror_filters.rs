//! A mirror filter keeps the capture's acceptance at the settings edge.
//!
//! `mirroring.static[].filters` is the capture's `SubscriptionFilter`, whose `kinds` admits a
//! range (`EventKinds | EventKindsRange`), and the capture never validates a mirror filter
//! (`src/utils/settings-config.ts` has no filter rule). The wire `Filter` narrowed `kinds` to
//! numbers (spec D4), so the settings type keeps `KindSelector` and crosses over at use
//! (round-2 architecture finding 1).

// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;

use nostream_config::settings::{Mirror, Settings};
use nostream_core::Kind;
use serde_yaml::Value;

fn defaults() -> Value {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../resources/default-settings.yaml"
    ))
    .expect("the shipped defaults are readable");

    serde_yaml::from_str(&raw).expect("the shipped defaults are valid YAML")
}

/// The document the architecture review measured: a mirror filter with a kind range, which
/// the capture accepts and which loaded here before `Filter.kinds` narrowed.
fn document_with_range_filter() -> Value {
    let mut document = defaults();
    let mirror = serde_yaml::from_str::<Value>(
        r#"
address: wss://mirror.example.com
filters:
  - kinds:
      - [10000, 19999]
  - kinds: [1]
    "#,
    )
    .expect("the mirror block is valid YAML");

    document["mirroring"]["static"] = Value::Sequence(vec![mirror]);

    document
}

#[test]
fn a_mirror_filter_with_a_kind_range_fits_the_typed_settings() {
    let settings: Settings =
        serde_yaml::from_value(document_with_range_filter()).expect("the mirror filter fits");

    let static_mirrors = settings
        .mirroring
        .expect("mirroring is in the defaults")
        .static_
        .expect("the document sets mirroring.static");
    let filters = static_mirrors[0]
        .filters
        .as_ref()
        .expect("the document sets filters");

    assert_eq!(filters.len(), 2);
}

#[test]
fn the_typed_settings_round_trip_the_range_filter_document() {
    let document = document_with_range_filter();
    let settings: Settings = serde_yaml::from_value(document.clone()).unwrap();
    let again = serde_yaml::to_value(&settings).unwrap();

    assert_eq!(again["mirroring"], document["mirroring"]);
}

#[test]
fn the_wire_filter_drops_a_range_element_and_keeps_the_numbers() {
    let settings: Settings = serde_yaml::from_value(document_with_range_filter()).unwrap();
    let mirror: &Mirror = &settings
        .mirroring
        .expect("mirroring is in the defaults")
        .static_
        .expect("the document sets mirroring.static")[0];

    let filters: Vec<_> = mirror
        .filters
        .as_ref()
        .unwrap()
        .clone()
        .into_iter()
        .map(|filter| filter.into_filter())
        .collect();

    // The capture's matcher used `Array.includes` on numbers, so a range element never
    // matched there either: dropping it keeps the same decisions.
    assert_eq!(filters[0].kinds, Some(Vec::new()));
    assert_eq!(filters[1].kinds, Some(vec![Kind::TEXT_NOTE]));
}
