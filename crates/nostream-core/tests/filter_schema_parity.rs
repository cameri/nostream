//! Parity with `test/unit/schemas/filter-schema.spec.ts` (47 mocha cases, measured green at
//! the capture commit `242a3001`): 4 acceptances (`:25-67`), 29 generated rejections
//! (`:69-141`), 6 NIP-50 search cases (`:144-187`) and 8 NIP-12 geohash cases (`:190-232`).
//!
//! **Messages.** The mocha suite asserts only that an error exists; the strings in its table
//! are the case *names*. The capture's zod 3 schema emits its own text, measured against the
//! capture tree ("Expected array, received null", "String must contain at most 64
//! character(s)", "Invalid", "Number must be greater than or equal to 0", "Expected integer,
//! received float", "Invalid timestamp", "Unknown key: <key>", "Invalid geohash filter"), and
//! that measured text is what `validate_filter` reproduces and what these tests assert —
//! a stricter check than the capture's, against the capture's own output rather than its
//! test names (spec D11's list is the case names; see build.md and ADR 0002).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nostream_core::filter::{Filter, validate_filter};
use serde_json::{Value, json};

/// The fixture every generated case mutates (`filter-schema.spec.ts:12-22`).
fn base() -> Value {
    json!({
        "ids": ["aaaa", "bbbb", "cccc"],
        "authors": ["aaaa", "bbbb", "cccc"],
        "kinds": [0, 1, 2, 3],
        "since": 1000,
        "until": 1000,
        "limit": 100,
        "#e": ["aa", "bb", "cc"],
        "#p": ["dd", "ee", "ff"],
        "#r": ["00", "11", "22"],
    })
}

fn issue_lines(document: &Value) -> Vec<String> {
    match validate_filter(document) {
        Ok(_) => Vec::new(),
        Err(issues) => issues.iter().map(ToString::to_string).collect(),
    }
}

fn assert_issues(document: &Value, expected: &[&str]) {
    assert_eq!(issue_lines(document), expected);
}

fn assert_matches_input(document: &Value) {
    let validated = validate_filter(document).unwrap();
    let deserialised: Filter = serde_json::from_value(document.clone()).unwrap();

    assert_eq!(validated, deserialised);
}

// --- validate filter schema: acceptances (4) ---------------------------------------------

#[test]
fn accepts_nip22_comment_threading_filters_for_kind_1111() {
    let document = json!({
        "kinds": [1111],
        "#E": ["aaaa"],
        "#K": ["1"],
        "#I": ["identifier1"],
        "#A": ["10000:pubkey:dtag"],
    });

    assert_matches_input(&document);
}

#[test]
fn accepts_uppercase_tag_filters_a_to_z() {
    let mut document = base();
    document["#I"] = json!(["identifier1", "identifier2"]);
    document["#K"] = json!(["1111"]);
    document["#E"] = json!(["aa", "bb"]);
    document["#A"] = json!(["10000:pubkey:dtag"]);

    assert_matches_input(&document);
}

#[test]
fn validate_filter_schema_returns_same_filter_if_filter_is_valid() {
    assert_matches_input(&base());
}

#[test]
fn accepts_empty_strings_in_generic_tag_filters() {
    assert_matches_input(&json!({"#d": [""]}));
}

// --- validate filter schema: generated rejections (29) -----------------------------------

#[test]
fn ids_must_be_an_array() {
    let mut document = base();
    document["ids"] = Value::Null;

    assert_issues(&document, &["ids: Expected array, received null"]);
}

#[test]
fn ids_0_length_must_be_less_than_or_equal_to_64_characters_long() {
    let mut document = base();
    document["ids"][0] = json!("f".repeat(65));

    assert_issues(
        &document,
        &["ids[0]: String must contain at most 64 character(s)"],
    );
}

#[test]
fn ids_0_must_only_contain_hexadecimal_characters() {
    let mut document = base();
    document["ids"][0] = json!("not hex");

    assert_issues(&document, &["ids[0]: Invalid"]);
}

#[test]
fn ids_0_is_not_allowed_to_be_empty() {
    let mut document = base();
    document["ids"][0] = json!("");

    assert_issues(
        &document,
        &[
            "ids[0]: Invalid",
            "ids[0]: String must contain at least 4 character(s)",
        ],
    );
}

#[test]
fn authors_must_be_an_array() {
    let mut document = base();
    document["authors"] = Value::Null;

    assert_issues(&document, &["authors: Expected array, received null"]);
}

#[test]
fn authors_0_length_must_be_less_than_or_equal_to_64_characters_long() {
    let mut document = base();
    document["authors"][0] = json!("f".repeat(65));

    assert_issues(
        &document,
        &["authors[0]: String must contain at most 64 character(s)"],
    );
}

#[test]
fn authors_0_must_only_contain_hexadecimal_characters() {
    let mut document = base();
    document["authors"][0] = json!("not hex");

    assert_issues(&document, &["authors[0]: Invalid"]);
}

#[test]
fn authors_0_is_not_allowed_to_be_empty() {
    let mut document = base();
    document["authors"][0] = json!("");

    assert_issues(
        &document,
        &[
            "authors[0]: Invalid",
            "authors[0]: String must contain at least 4 character(s)",
        ],
    );
}

#[test]
fn kinds_must_be_an_array() {
    let mut document = base();
    document["kinds"] = Value::Null;

    assert_issues(&document, &["kinds: Expected array, received null"]);
}

#[test]
fn kinds_0_must_be_greater_than_or_equal_to_0() {
    let mut document = base();
    document["kinds"][0] = json!(-1);

    assert_issues(
        &document,
        &["kinds[0]: Number must be greater than or equal to 0"],
    );
}

#[test]
fn kinds_0_must_be_a_number() {
    let mut document = base();
    document["kinds"][0] = Value::Null;

    assert_issues(&document, &["kinds[0]: Expected number, received null"]);
}

#[test]
fn kinds_0_must_be_a_multiple_of_1() {
    let mut document = base();
    document["kinds"][0] = json!(std::f64::consts::PI);

    assert_issues(&document, &["kinds[0]: Expected integer, received float"]);
}

#[test]
fn since_contains_an_invalid_value() {
    let mut document = base();
    document["since"] = json!(1_672_295_751_103_i64);

    assert_issues(&document, &["since: Invalid timestamp"]);
}

#[test]
fn since_must_be_a_number() {
    let mut document = base();
    document["since"] = Value::Null;

    assert_issues(&document, &["since: Expected number, received null"]);
}

#[test]
fn since_must_be_greater_than_or_equal_to_0() {
    let mut document = base();
    document["since"] = json!(-1);

    assert_issues(
        &document,
        &[
            "since: Number must be greater than or equal to 0",
            "since: Invalid timestamp",
        ],
    );
}

#[test]
fn since_must_be_a_multiple_of_1() {
    let mut document = base();
    document["since"] = json!(std::f64::consts::PI);

    assert_issues(
        &document,
        &[
            "since: Expected integer, received float",
            "since: Invalid timestamp",
        ],
    );
}

#[test]
fn until_contains_an_invalid_value() {
    let mut document = base();
    document["until"] = json!(1_672_295_751_103_i64);

    assert_issues(&document, &["until: Invalid timestamp"]);
}

#[test]
fn until_must_be_a_number() {
    let mut document = base();
    document["until"] = Value::Null;

    assert_issues(&document, &["until: Expected number, received null"]);
}

#[test]
fn until_must_be_greater_than_or_equal_to_0() {
    let mut document = base();
    document["until"] = json!(-1);

    assert_issues(
        &document,
        &[
            "until: Number must be greater than or equal to 0",
            "until: Invalid timestamp",
        ],
    );
}

#[test]
fn until_must_be_a_multiple_of_1() {
    let mut document = base();
    document["until"] = json!(std::f64::consts::PI);

    assert_issues(
        &document,
        &[
            "until: Expected integer, received float",
            "until: Invalid timestamp",
        ],
    );
}

#[test]
fn limit_must_be_a_number() {
    let mut document = base();
    document["limit"] = Value::Null;

    assert_issues(&document, &["limit: Expected number, received null"]);
}

#[test]
fn limit_must_be_greater_than_or_equal_to_0() {
    let mut document = base();
    document["limit"] = json!(-1);

    assert_issues(
        &document,
        &["limit: Number must be greater than or equal to 0"],
    );
}

#[test]
fn limit_must_be_a_multiple_of_1() {
    let mut document = base();
    document["limit"] = json!(std::f64::consts::PI);

    assert_issues(&document, &["limit: Expected integer, received float"]);
}

#[test]
fn e_must_be_an_array() {
    let mut document = base();
    document["#e"] = Value::Null;

    assert_issues(&document, &["#e: Expected array, received null"]);
}

#[test]
fn e_0_length_must_be_less_than_or_equal_to_1024_characters_long() {
    let mut document = base();
    document["#e"][0] = json!("f".repeat(1025));

    assert_issues(
        &document,
        &["#e[0]: String must contain at most 1024 character(s)"],
    );
}

#[test]
fn p_must_be_an_array() {
    let mut document = base();
    document["#p"] = Value::Null;

    assert_issues(&document, &["#p: Expected array, received null"]);
}

#[test]
fn p_0_length_must_be_less_than_or_equal_to_1024_characters_long() {
    let mut document = base();
    document["#p"][0] = json!("f".repeat(1025));

    assert_issues(
        &document,
        &["#p[0]: String must contain at most 1024 character(s)"],
    );
}

#[test]
fn r_must_be_an_array() {
    let mut document = base();
    document["#r"] = Value::Null;

    assert_issues(&document, &["#r: Expected array, received null"]);
}

#[test]
fn r_0_length_must_be_less_than_or_equal_to_1024_characters_long() {
    let mut document = base();
    document["#r"][0] = json!("f".repeat(1025));

    assert_issues(
        &document,
        &["#r[0]: String must contain at most 1024 character(s)"],
    );
}

// --- NIP-50: search filter (6) -----------------------------------------------------------

#[test]
fn nip50_accepts_filter_with_valid_search_string() {
    assert_matches_input(&json!({"search": "bitcoin lightning"}));
}

#[test]
fn nip50_accepts_search_combined_with_kinds_and_limit() {
    assert_matches_input(&json!({"search": "nostr relay", "kinds": [1], "limit": 20}));
}

#[test]
fn nip50_accepts_search_combined_with_authors_and_tags() {
    assert_matches_input(&json!({
        "search": "bitcoin",
        "authors": ["22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793"],
        "#e": ["aaaaaa"],
    }));
}

#[test]
fn nip50_rejects_empty_search_string() {
    assert_issues(
        &json!({"search": ""}),
        &["search: String must contain at least 1 character(s)"],
    );
}

#[test]
fn nip50_rejects_search_string_longer_than_1024_characters() {
    assert_issues(
        &json!({"search": "a".repeat(1025)}),
        &["search: String must contain at most 1024 character(s)"],
    );
}

#[test]
fn nip50_accepts_search_string_at_maximum_length_of_1024_characters() {
    assert_matches_input(&json!({"search": "a".repeat(1024)}));
}

// --- NIP-12: #g filter validation (8) ----------------------------------------------------

#[test]
fn nip12_accepts_a_valid_base32_geohash() {
    assert_matches_input(&json!({"#g": ["u4pruydqqvj"]}));
}

#[test]
fn nip12_accepts_a_valid_geohash_prefix_with_trailing_wildcard() {
    assert_matches_input(&json!({"#g": ["u4pruyd*"]}));
}

#[test]
fn nip12_rejects_an_empty_criterion() {
    assert_issues(&json!({"#g": [""]}), &["#g[0]: Invalid geohash filter"]);
}

#[test]
fn nip12_rejects_a_bare_wildcard() {
    assert_issues(&json!({"#g": ["*"]}), &["#g[0]: Invalid geohash filter"]);
}

#[test]
fn nip12_rejects_non_base32_characters() {
    assert_issues(
        &json!({"#g": ["u4pruyda"]}),
        &["#g[0]: Invalid geohash filter"],
    );
}

#[test]
fn nip12_rejects_uppercase_characters() {
    assert_issues(
        &json!({"#g": ["U4PRUYDQQVJ"]}),
        &["#g[0]: Invalid geohash filter"],
    );
}

#[test]
fn nip12_rejects_wildcard_not_at_the_end() {
    assert_issues(
        &json!({"#g": ["u4*pruyd"]}),
        &["#g[0]: Invalid geohash filter"],
    );
}

#[test]
fn nip12_rejects_multiple_wildcards() {
    assert_issues(
        &json!({"#g": ["u4pruyd**"]}),
        &["#g[0]: Invalid geohash filter"],
    );
}

// --- round-2 findings: UTF-16 length units and the u64 representability edge -------------

#[test]
fn nip50_rejects_an_astral_search_string_longer_than_1024_utf16_units() {
    // 600 emoji are 600 scalar values but 1200 UTF-16 code units, which is what zod counts.
    assert_issues(
        &json!({"search": "😀".repeat(600)}),
        &["search: String must contain at most 1024 character(s)"],
    );
}

#[test]
fn accepts_an_astral_search_string_at_exactly_1024_utf16_units() {
    assert_matches_input(&json!({"search": "😀".repeat(512)}));
}

#[test]
fn rejects_an_astral_tag_criterion_longer_than_1024_utf16_units() {
    assert_issues(
        &json!({"#e": ["😀".repeat(513)]}),
        &["#e[0]: String must contain at most 1024 character(s)"],
    );
}

#[test]
fn rejects_an_astral_prefix_longer_than_64_utf16_units() {
    // 33 emoji are 66 UTF-16 units, over the 64-unit bound and under it in scalar values
    // (33). They are not hex, so the regex issue comes first, as it does in zod.
    assert_issues(
        &json!({"ids": ["😀".repeat(33)]}),
        &[
            "ids[0]: Invalid",
            "ids[0]: String must contain at most 64 character(s)",
        ],
    );
}

#[test]
fn kinds_beyond_u64_are_refused_as_a_representability_divergence() {
    // The capture accepts `kinds: [1e20]` (a JavaScript number); `Kind` is a `u64`, so the
    // value cannot be held. This is a recorded divergence (ADR 0002), not a zod rule, and the
    // message says so in its own words rather than imitating zod's phrasing.
    let issues = issue_lines(&json!({"kinds": [1e20]}));

    assert_eq!(issues, vec!["kinds[0]: kind value does not fit in 64 bits"]);
    assert!(issue_lines(&json!({"kinds": [1e19]})).is_empty());
}

#[test]
fn limit_beyond_u64_is_refused_as_a_representability_divergence() {
    let issues = issue_lines(&json!({"limit": 1e20}));

    assert_eq!(issues, vec!["limit: limit does not fit in 64 bits"]);
    assert!(issue_lines(&json!({"limit": 1e19})).is_empty());
}
