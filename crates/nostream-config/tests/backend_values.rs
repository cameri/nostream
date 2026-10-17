//! `eventStore.backend` accepts the rewrite's LMDB backend (spec D7) and still rejects
//! anything outside the two-member set, with the two-member message.

use std::fs;

use nostream_config::path::set_by_path;
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

fn with_backend(backend: &str) -> Vec<nostream_config::Issue> {
    let defaults = defaults();
    let document = set_by_path(
        &defaults,
        "eventStore.backend",
        Value::String(backend.to_owned()),
    )
    .expect("the path is writable");
    validate_document(&document, &defaults)
        .into_iter()
        .filter(|issue| issue.path.starts_with("eventStore"))
        .collect()
}

#[test]
fn postgres_is_accepted() {
    assert_eq!(with_backend("postgres"), Vec::new());
}

#[test]
fn lmdb_is_accepted() {
    assert_eq!(with_backend("lmdb"), Vec::new());
}

#[test]
fn an_unknown_backend_is_rejected_with_both_members_named() {
    assert_eq!(
        with_backend("sqlite"),
        vec![nostream_config::Issue::new(
            "eventStore.backend",
            "backend must be one of: postgres, lmdb"
        )]
    );
}
