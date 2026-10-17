//! The dot-path editor and value parser, ported from `test/unit/utils/settings-config.spec.ts`.

use std::fs;

use nostream_config::path::{
    PathError, ParsedValue, get_by_path, parse_path, parse_typed_json, parse_value, set_by_path,
    validate_path_against_defaults,
};
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
fn parses_primitive_values() {
    assert_eq!(parse_value("true"), ParsedValue::Bool(true));
    assert_eq!(parse_value("false"), ParsedValue::Bool(false));
    assert_eq!(parse_value("42"), ParsedValue::Number(42));
    assert_eq!(parse_value("42n"), ParsedValue::BigInt("42".to_owned()));
    assert_eq!(parse_value("null"), ParsedValue::Null);
    assert_eq!(parse_value("hello"), ParsedValue::String("hello".to_owned()));
}

#[test]
fn an_unsafe_integer_falls_back_to_a_string() {
    assert_eq!(
        parse_value("99999999999999999999"),
        ParsedValue::String("99999999999999999999".to_owned())
    );
}

#[test]
fn parses_typed_json_values() {
    let object = parse_typed_json("{\"enabled\":true}").expect("json object");
    assert_eq!(
        get_by_path(&object, "enabled").expect("path"),
        Some(&Value::Bool(true))
    );
    let array = parse_typed_json("[1,2,3]").expect("json array");
    assert!(matches!(array, Value::Sequence(entries) if entries.len() == 3));
    assert!(
        parse_typed_json("{")
            .expect_err("invalid json")
            .starts_with("Invalid JSON value")
    );
}

#[test]
fn sets_and_gets_dot_path_values() {
    let document: Value = serde_yaml::from_str("payments:\n  enabled: false\n").expect("doc");
    let updated = set_by_path(&document, "payments.enabled", Value::Bool(true)).expect("set");
    assert_eq!(
        get_by_path(&updated, "payments.enabled").expect("get"),
        Some(&Value::Bool(true))
    );
    assert_eq!(get_by_path(&updated, "payments.processor").expect("get"), None);
}

#[test]
fn supports_indexed_path_syntax() {
    let document: Value = serde_yaml::from_str(
        "limits:\n  event:\n    content:\n      - maxLength: 100\n",
    )
    .expect("doc");
    let updated = set_by_path(
        &document,
        "limits.event.content[0].maxLength",
        Value::Number(500.into()),
    )
    .expect("set");
    assert_eq!(
        get_by_path(&updated, "limits.event.content[0].maxLength").expect("get"),
        Some(&Value::Number(500.into()))
    );
}

#[test]
fn rejects_malformed_path_syntax() {
    let document: Value = serde_yaml::from_str("{}").expect("doc");
    assert_eq!(
        set_by_path(&document, "payments[]", Value::Bool(true)),
        Err(PathError::InvalidSegment("payments[]".to_owned()))
    );
}

#[test]
fn rejects_reserved_prototype_keys() {
    let document: Value = serde_yaml::from_str("payments:\n  enabled: false\n").expect("doc");
    for path in ["__proto__.enabled", "constructor.enabled", "prototype.enabled"] {
        let key = path.split('.').next().expect("key");
        assert_eq!(
            set_by_path(&document, path, Value::Bool(true)),
            Err(PathError::InvalidSegment(key.to_owned()))
        );
        assert_eq!(
            get_by_path(&document, path),
            Err(PathError::InvalidSegment(key.to_owned()))
        );
    }
}

#[test]
fn requires_a_path() {
    let document: Value = serde_yaml::from_str("{}").expect("doc");
    assert_eq!(parse_path("   "), Err(PathError::Required));
    assert_eq!(
        set_by_path(&document, "", Value::Null),
        Err(PathError::Required)
    );
}

#[test]
fn rejects_an_empty_segment() {
    assert_eq!(
        parse_path("info..name"),
        Err(PathError::InvalidSegmentIn("info..name".to_owned()))
    );
}

#[test]
fn validates_known_paths_against_the_defaults() {
    let defaults = defaults();
    assert_eq!(
        validate_path_against_defaults(&defaults, "payments.enabled").expect("path"),
        Vec::new()
    );
    assert_eq!(
        validate_path_against_defaults(&defaults, "limits.event.content[0].maxLength")
            .expect("path"),
        Vec::new()
    );
    let issues = validate_path_against_defaults(&defaults, "payments.fakeField").expect("path");
    assert_eq!(issues[0].path, "payments.fakeField");
    assert!(issues[0].message.contains("does not exist"));
}

#[test]
fn extends_arrays_when_an_index_is_beyond_the_end() {
    let defaults = defaults();
    let updated = set_by_path(
        &defaults,
        "mirroring.static[1].address",
        Value::String("wss://mirror.example".to_owned()),
    )
    .expect("set");
    let Value::Sequence(entries) = get_by_path(&updated, "mirroring.static")
        .expect("path")
        .expect("the list exists")
    else {
        panic!("mirroring.static is a sequence");
    };
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0], Value::Null);
    assert_eq!(
        get_by_path(&updated, "mirroring.static[1].address").expect("path"),
        Some(&Value::String("wss://mirror.example".to_owned()))
    );
}

#[test]
fn replacing_a_scalar_with_an_object_follows_the_path_shape() {
    let document: Value = serde_yaml::from_str("workers:\n  count: 0\n").expect("doc");
    let updated = set_by_path(&document, "workers.count.value", Value::Null).expect("set");
    assert_eq!(
        get_by_path(&updated, "workers.count.value").expect("path"),
        Some(&Value::Null)
    );
}

#[test]
fn a_key_followed_by_an_index_becomes_an_array() {
    // The capture replaces a non-array value with `[]` when the next token is an index,
    // so this is an assignment, not an error.
    let document: Value = serde_yaml::from_str("network: {}\n").expect("doc");
    let updated = set_by_path(&document, "network[0]", Value::Null).expect("set");
    assert_eq!(
        get_by_path(&updated, "network").expect("path").cloned(),
        Some(serde_yaml::from_str::<Value>("[null]").expect("seq"))
    );
}

#[test]
fn reading_a_missing_path_is_none() {
    let document: Value = serde_yaml::from_str("info:\n  name: relay\n").expect("doc");
    assert_eq!(get_by_path(&document, "info.relay_url").expect("path"), None);
    assert_eq!(get_by_path(&document, "network.maxPayloadSize").expect("path"), None);
    assert_eq!(get_by_path(&document, "info[0]").expect("path"), None);
}
