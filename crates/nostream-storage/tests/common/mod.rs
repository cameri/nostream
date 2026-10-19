//! Helpers shared by the storage integration tests. A directory module, so cargo does not
//! build it as a target of its own.

#![allow(dead_code)]

use nostream_config::Settings;
use serde_json::Value;

/// The shipped defaults with a fixture's overrides applied — the settings both the capture
/// and the replay load, so the gates under test are the fixture's.
pub fn settings_from_fixture(fixture: &Value) -> Settings {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../resources/default-settings.yaml"
    ))
    .expect("the shipped defaults are readable");
    let mut document: serde_yaml::Value =
        serde_yaml::from_str(&raw).expect("the shipped defaults are valid YAML");
    if let Some(overrides) = fixture["settings"]["overrides"].as_object() {
        for (path, value) in overrides {
            let yaml = serde_yaml::to_value(value).expect("a YAML value");
            document = nostream_config::path::set_by_path(&document, path, yaml)
                .expect("the override path is writable");
        }
    }
    serde_yaml::from_value(document).expect("the settings fit the typed schema")
}
