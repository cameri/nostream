//! Parity with `test/unit/utils/filter.spec.ts` (9 mocha cases, measured green at the
//! capture commit `242a3001`): `isGenericTagQuery` (4) and `countFilterValues` (5).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nostream_core::filter::{Filter, is_generic_tag_query};

fn filter(document: &str) -> Filter {
    serde_json::from_str(document).unwrap()
}

// --- isGenericTagQuery (4) ---------------------------------------------------------------

#[test]
fn is_generic_tag_query_returns_true_for_a() {
    assert!(is_generic_tag_query("#a"));
}

#[test]
fn is_generic_tag_query_returns_true_for_uppercase_a() {
    assert!(is_generic_tag_query("#A"));
}

#[test]
fn is_generic_tag_query_returns_false_for_0() {
    assert!(!is_generic_tag_query("#0"));
}

#[test]
fn is_generic_tag_query_returns_false_for_abc() {
    assert!(!is_generic_tag_query("#abc"));
}

// --- countFilterValues (5) ---------------------------------------------------------------

#[test]
fn count_filter_values_returns_zero_for_a_filter_without_array_criteria() {
    assert_eq!(filter("{}").value_count(), 0);
}

#[test]
fn count_filter_values_sums_values_across_every_array_criterion() {
    assert_eq!(
        filter(r#"{"ids":["aa"],"authors":["bb","cc"],"kinds":[1,2,3]}"#).value_count(),
        6
    );
}

#[test]
fn count_filter_values_counts_generic_tag_criteria() {
    assert_eq!(
        filter(r##"{"#e":["aa","bb"],"#p":["cc"]}"##).value_count(),
        3
    );
}

#[test]
fn count_filter_values_does_not_count_scalar_criteria() {
    assert_eq!(
        filter(r#"{"ids":["aa"],"since":1,"until":2,"limit":3,"search":"aa bb cc"}"#).value_count(),
        1
    );
}

#[test]
fn count_filter_values_does_not_count_empty_criteria() {
    assert_eq!(filter(r#"{"ids":[],"authors":["aa"]}"#).value_count(), 1);
}
