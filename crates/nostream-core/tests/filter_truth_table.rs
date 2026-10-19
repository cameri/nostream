//! The matcher's truth table: the 31 probe lines measured at the capture
//! (`recon.md` §3, `src/utils/event.ts:39-119`) plus the two that are `Filter`-level
//! decisions (line 29, the range element, and line 30, `limit` only).
//!
//! Probe event: id `aa`×32, pubkey `bb`×32, `created_at` 1000, kind 7, content
//! `Bitcoin Lightning`, tags `[["e","AA","wss://relay"],["e","BB"],["p","CC"],["d",""],
//! ["D","DD"],["expiration","E1"],["g","u4pruydqqvj"]]`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nostream_core::filter::{Filter, validate_filter};
use nostream_core::{Event, Kind, Signature};
use serde_json::json;

const PROBE_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROBE_PUBKEY: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn probe_event() -> Event {
    Event {
        id: PROBE_ID.parse().unwrap(),
        pubkey: PROBE_PUBKEY.parse().unwrap(),
        created_at: 1000,
        kind: Kind(7),
        tags: vec![
            vec!["e".to_owned(), "AA".to_owned(), "wss://relay".to_owned()],
            vec!["e".to_owned(), "BB".to_owned()],
            vec!["p".to_owned(), "CC".to_owned()],
            vec!["d".to_owned(), String::new()],
            vec!["D".to_owned(), "DD".to_owned()],
            vec!["expiration".to_owned(), "E1".to_owned()],
            vec!["g".to_owned(), "u4pruydqqvj".to_owned()],
        ],
        content: "Bitcoin Lightning".to_owned(),
        sig: Signature::from_byte_array([0; 64]),
    }
}

fn matches(filter: serde_json::Value) -> bool {
    serde_json::from_value::<Filter>(filter)
        .unwrap()
        .matches(&probe_event())
}

#[test]
fn line_1_exact_tag_value_matches() {
    assert!(matches(json!({"#e": ["AA"]})));
}

#[test]
fn line_2_tag_value_only_not_tag_third_element() {
    assert!(!matches(json!({"#e": ["wss://relay"]})));
}

#[test]
fn line_3_tag_value_is_not_a_prefix() {
    assert!(!matches(json!({"#e": ["A"]})));
}

#[test]
fn line_4_uppercase_key_is_a_different_tag_name() {
    assert!(!matches(json!({"#E": ["AA"]})));
}

#[test]
fn line_5_uppercase_tag_name_matches() {
    assert!(matches(json!({"#D": ["DD"]})));
}

#[test]
fn line_6_empty_tag_value_matches() {
    assert!(matches(json!({"#d": [""]})));
}

#[test]
fn line_7_non_single_letter_key_is_silently_ignored() {
    assert!(matches(json!({"#expiration": ["E1"]})));
}

#[test]
fn line_8_multi_letter_key_is_ignored() {
    assert!(matches(json!({"#ee": ["zzz"]})));
}

#[test]
fn line_9_empty_tag_criterion_never_matches() {
    assert!(!matches(json!({"#e": []})));
}

#[test]
fn line_10_ids_prefix_of_eight_characters_matches() {
    assert!(matches(json!({"ids": ["aaaaaaaa"]})));
}

#[test]
fn line_11_ids_prefix_of_one_character_matches() {
    assert!(matches(json!({"ids": ["a"]})));
}

#[test]
fn line_12_empty_ids_criterion_never_matches() {
    assert!(!matches(json!({"ids": []})));
}

#[test]
fn line_13_authors_prefix_matches() {
    assert!(matches(json!({"authors": ["bb"]})));
}

#[test]
fn line_14_kinds_contains_the_event_kind() {
    assert!(matches(json!({"kinds": [7]})));
}

#[test]
fn line_15_kinds_mismatch() {
    assert!(!matches(json!({"kinds": [8]})));
}

#[test]
fn line_16_since_equal_to_created_at_matches() {
    assert!(matches(json!({"since": 1000})));
}

#[test]
fn line_17_since_after_created_at_does_not_match() {
    assert!(!matches(json!({"since": 1001})));
}

#[test]
fn line_18_until_equal_to_created_at_matches() {
    assert!(matches(json!({"until": 1000})));
}

#[test]
fn line_19_until_before_created_at_does_not_match() {
    assert!(!matches(json!({"until": 999})));
}

#[test]
fn line_20_search_is_case_insensitive() {
    assert!(matches(json!({"search": "bitcoin"})));
}

#[test]
fn line_21_search_requires_every_term() {
    assert!(matches(json!({"search": "bitcoin lightning"})));
}

#[test]
fn line_22_search_term_absent_from_content_does_not_match() {
    assert!(!matches(json!({"search": "ethereum"})));
}

#[test]
fn line_23_search_reads_content_not_tags() {
    assert!(!matches(json!({"search": "AA"})));
}

#[test]
fn line_24_whitespace_only_search_matches_nothing() {
    assert!(!matches(json!({"search": "   "})));
}

#[test]
fn line_25_empty_search_matches_everything() {
    assert!(matches(json!({"search": ""})));
}

#[test]
fn line_26_geohash_wildcard_matches_a_prefix() {
    assert!(matches(json!({"#g": ["u4pruyd*"]})));
}

#[test]
fn line_27_geohash_without_wildcard_is_exact() {
    assert!(!matches(json!({"#g": ["u4pruyd"]})));
}

#[test]
fn line_28_geohash_full_value_matches() {
    assert!(matches(json!({"#g": ["u4pruydqqvj"]})));
}

#[test]
fn line_29_kind_range_element_is_rejected_by_both_paths() {
    let document = r#"{"kinds":[[10000,19999]]}"#;

    assert!(serde_json::from_str::<Filter>(document).is_err());

    let issues = validate_filter(&json!({"kinds": [[10000, 19999]]})).unwrap_err();
    assert_eq!(issues[0].path, "kinds[0]");
    // Measured against the capture's zod 3 schema, whose message is what `validate_filter`
    // reproduces; the spec's D11 list carries the mocha case *names* here.
    assert_eq!(issues[0].message, "Expected number, received array");
    assert_eq!(
        issues[0].to_string(),
        "kinds[0]: Expected number, received array"
    );
}

#[test]
fn line_30_limit_only_never_rejects() {
    assert!(matches(json!({"limit": 10})));
}

#[test]
fn line_31_search_against_empty_content_does_not_match() {
    let mut event = probe_event();
    event.content = String::new();

    let filter: Filter = serde_json::from_str(r#"{"search":"x"}"#).unwrap();

    assert!(!filter.matches(&event));
}
