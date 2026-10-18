//! The typed schema must round-trip the shipped defaults: parse → deserialize → serialize is
//! the same document. This is what proves every serde rename, every `Option`, and every
//! untagged enum is right, and it is why `validate(&Settings)` may delegate to the document
//! validator.

use std::fs;

use nostream_config::settings::Settings;
use nostream_config::validate_document;
use serde_yaml::Value;

fn defaults() -> Value {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../resources/default-settings.yaml"
    ))
    .expect("the shipped defaults are readable");
    serde_yaml::from_str(&raw).expect("the shipped defaults are valid YAML")
}

#[test]
fn the_shipped_defaults_validate_with_no_issues() {
    let defaults = defaults();
    let issues = validate_document(&defaults, &defaults);
    assert_eq!(
        issues,
        Vec::new(),
        "the shipped defaults must validate clean"
    );
}

#[test]
fn the_typed_schema_round_trips_the_defaults() {
    let defaults = defaults();
    let settings: Settings =
        serde_yaml::from_value(defaults.clone()).expect("the defaults fit the typed schema");
    let again = serde_yaml::to_value(&settings).expect("the typed settings serialize");

    let mut differences = Vec::new();
    first_differences(&again, &defaults, "$", &mut differences, 10);
    assert!(
        differences.is_empty(),
        "serializing the typed settings must reproduce the defaults document:\n{}",
        differences.join("\n")
    );
}

#[test]
fn the_typed_settings_revalidate_clean() {
    let defaults = defaults();
    let settings: Settings =
        serde_yaml::from_value(defaults.clone()).expect("the defaults fit the typed schema");
    let issues = nostream_config::validate(&settings, &defaults).expect("validation runs");
    assert_eq!(issues, Vec::new());
}

/// Collects up to `limit` path-level differences between two documents.
fn first_differences(
    left: &Value,
    right: &Value,
    path: &str,
    differences: &mut Vec<String>,
    limit: usize,
) {
    if differences.len() >= limit {
        return;
    }
    match (left, right) {
        (Value::Mapping(left_map), Value::Mapping(right_map)) => {
            for (key, left_value) in left_map {
                let child = format!("{path}.{}", key.as_str().unwrap_or("?"));
                match right_map.get(key) {
                    Some(right_value) => {
                        first_differences(left_value, right_value, &child, differences, limit)
                    }
                    None => differences.push(format!("{child}: only in serialized output")),
                }
            }
            for (key, _) in right_map {
                if !left_map.contains_key(key) {
                    let child = format!("{path}.{}", key.as_str().unwrap_or("?"));
                    differences.push(format!("{child}: missing from serialized output"));
                }
            }
        }
        (Value::Sequence(left_items), Value::Sequence(right_items)) => {
            if left_items.len() != right_items.len() {
                differences.push(format!(
                    "{path}: length {} vs {}",
                    left_items.len(),
                    right_items.len()
                ));
                return;
            }
            for (index, (left_item, right_item)) in
                left_items.iter().zip(right_items.iter()).enumerate()
            {
                first_differences(
                    left_item,
                    right_item,
                    &format!("{path}[{index}]"),
                    differences,
                    limit,
                );
            }
        }
        (left, right) if left != right => {
            differences.push(format!("{path}: {left:?} vs {right:?}"));
        }
        _ => {}
    }
}
