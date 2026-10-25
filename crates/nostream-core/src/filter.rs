//! Subscription filters. Mirrors `src/@types/subscription.ts`, `src/utils/filter.ts` and
//! `src/schemas/filter-schema.ts`.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{Event, Kind};
use crate::validation::CREATED_AT_LIMIT;

/// A subscription id (`src/@types/subscription.ts` `SubscriptionId`).
pub type SubscriptionId = String;

/// The geohash alphabet (`src/utils/geohash.ts` `GEOHASH_BASE32`, excludes `a`, `i`, `l`, `o`).
const GEOHASH_BASE32: &str = "0123456789bcdefghjkmnpqrstuvwxyz";

/// The filter keys the schema names (`src/schemas/filter-schema.ts` `knownFilterKeys`).
const KNOWN_FILTER_KEYS: [&str; 7] = [
    "ids", "authors", "kinds", "since", "until", "limit", "search",
];

/// The largest integer JavaScript represents exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `2^64`, the first value a `u64` cannot hold. `u64::MAX as f64` **is** this number — the
/// largest `f64` below it is `u64::MAX - 2047` — so the comparison must be `>=`, not `>`:
/// with `>`, exactly `2^64` passed and `as u64` silently saturated it to `u64::MAX`. It bounds
/// both refusals ADR 0002 decides:
/// `docs/rewrite/decisions/0002-core-crypto-and-negentropy.md:125-136`.
pub(crate) const U64_RANGE_END: f64 = 18_446_744_073_709_551_616.0;

/// The refusal for a `kind` no `u64` can hold. The capture's `kindSchema` has no ceiling, so
/// the message is a representability divergence rather than a zod rule, decided in
/// `docs/rewrite/decisions/0002-core-crypto-and-negentropy.md:125-136`. One statement of the
/// wording, shared with the event decoder.
pub(crate) const KIND_DOES_NOT_FIT: &str = "kind value does not fit in 64 bits";

/// A Nostr REQ filter (`src/@types/subscription.ts` `SubscriptionFilter`).
///
/// `ids` and `authors` hold hex **prefixes**: the schema admits 4..64 characters
/// (`src/schemas/base-schema.ts:11`), so a validated `EventId`/`Pubkey` cannot carry them,
/// and the matcher compares them as `startsWith` prefixes (`src/utils/event.ts:42,60`).
/// `kinds` holds numbers only: a range element is unrepresentable here because the matcher
/// compares with `Array.includes` on numbers (`src/utils/event.ts:64`) and a range never
/// matched.
///
/// Tag criteria are carried in `tags`, whose JSON keys are kept **verbatim**, `#` included:
/// `{"#e":["aa"]}` deserialises to `tags["#e"]`, which is what the capture's filter object
/// holds (`src/@types/subscription.ts`) and what round-trips the wire document unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Filter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<Kind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(flatten)]
    pub tags: BTreeMap<String, Vec<String>>,
}

impl Filter {
    /// Whether an event matches every criterion this filter carries
    /// (`isEventMatchingFilter`, `src/utils/event.ts:39-119`), in the capture's order.
    pub fn matches(&self, event: &Event) -> bool {
        if let Some(ids) = &self.ids
            && !ids
                .iter()
                .any(|prefix| hex_prefix_matches(event.id.as_bytes(), prefix))
        {
            return false;
        }

        if let Some(kinds) = &self.kinds
            && !kinds.contains(&event.kind)
        {
            return false;
        }

        if let Some(since) = self.since
            && event.created_at < since
        {
            return false;
        }

        if let Some(until) = self.until
            && event.created_at > until
        {
            return false;
        }

        if let Some(authors) = &self.authors
            && !authors
                .iter()
                .any(|prefix| hex_prefix_matches(event.pubkey.as_bytes(), prefix))
        {
            return false;
        }

        for (key, criteria) in &self.tags {
            if !is_generic_tag_query(key) {
                continue;
            }

            let name = &key[1..2];
            let is_geohash = key == "#g";

            let matched = event.tags.iter().any(|tag| {
                if tag.first().map(String::as_str) != Some(name) {
                    return false;
                }

                let Some(value) = tag.get(1) else {
                    return false;
                };

                criteria
                    .iter()
                    .any(|criterion| match criterion.strip_suffix('*') {
                        Some(prefix) if is_geohash => value.starts_with(prefix),
                        _ => value == criterion,
                    })
            });

            if !matched {
                return false;
            }
        }

        if let Some(search) = &self.search
            && !search.is_empty()
        {
            let content = event.content.to_lowercase();
            let query = search.to_lowercase();
            let mut terms = query.split_whitespace().peekable();

            if terms.peek().is_none() {
                return false;
            }

            if !terms.all(|term| content.contains(term)) {
                return false;
            }
        }

        true
    }

    /// The number of array-valued criteria this filter carries (`countFilterValues`,
    /// `src/utils/filter.ts:9-10`), which NIP-45's `COUNT` bounds.
    pub fn value_count(&self) -> usize {
        self.ids.as_ref().map_or(0, Vec::len)
            + self.authors.as_ref().map_or(0, Vec::len)
            + self.kinds.as_ref().map_or(0, Vec::len)
            + self.tags.values().map(Vec::len).sum::<usize>()
    }
}

/// The number of array-valued criteria a filter carries (`countFilterValues`,
/// `src/utils/filter.ts:9-10`): `ids`, `authors`, `kinds` and every `#`-criterion, each
/// contributing its length; scalar criteria (`since`, `until`, `limit`, `search`) contribute
/// nothing.
pub fn count_filter_values(filter: &Filter) -> usize {
    filter.value_count()
}

/// Whether a string is a single-letter tag query, `#` plus one ASCII letter
/// (`isGenericTagQuery`, `src/utils/filter.ts:4`). Any other key is ignored by the matcher.
pub fn is_generic_tag_query(key: &str) -> bool {
    let mut characters = key.chars();

    matches!(characters.next(), Some('#'))
        && characters
            .next()
            .is_some_and(|letter| letter.is_ascii_alphabetic())
        && characters.next().is_none()
}

/// Whether the lowercase hex rendering of `bytes` starts with `prefix`.
///
/// The comparison is on nibbles of the byte array, so no string is built. It is
/// case-sensitive, as `String.prototype.startsWith` on the lowercase id and pubkey is: a
/// criterion carrying any character outside `0-9a-f` cannot match.
fn hex_prefix_matches(bytes: &[u8], prefix: &str) -> bool {
    if prefix.len() > bytes.len() * 2 {
        return false;
    }

    prefix.bytes().enumerate().all(|(index, character)| {
        let byte = bytes[index / 2];
        let nibble = if index % 2 == 0 {
            byte >> 4
        } else {
            byte & 0x0f
        };

        let expected = match character {
            b'0'..=b'9' => character - b'0',
            b'a'..=b'f' => character - b'a' + 10,
            _ => return false,
        };

        nibble == expected
    })
}

/// One filter-validation finding, rendered `{path}: {message}` (`nostream_config::Issue`
/// has the same shape for settings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterIssue {
    pub path: String,
    pub message: String,
}

impl fmt::Display for FilterIssue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

/// Validates a raw filter document and builds the `Filter` (`filterSchema`,
/// `src/schemas/filter-schema.ts:12-44`).
///
/// The raw document is the input because the schema reports type errors ("Expected array,
/// received null") against a path, which a serde deserialisation deeper in a frame parser
/// cannot phrase. Every message is the one the capture's zod 3 schema emits, verbatim, with
/// two exceptions that are representability, not validation: the capture accepts a `kinds`
/// element or a `limit` that no `u64` can hold, and those two messages say so in their own
/// words (`kind value does not fit in 64 bits`, `limit does not fit in 64 bits`). A JSON
/// integer up to `u64::MAX` is carried exactly; the refused cell is an integer above
/// `u64::MAX` or a float at or above `2^64`. Recorded in ADR 0002.
pub fn validate_filter(value: &Value) -> Result<Filter, Vec<FilterIssue>> {
    let Some(object) = value.as_object() else {
        return Err(vec![FilterIssue {
            path: String::new(),
            message: invalid_type("object", value),
        }]);
    };

    let mut issues: Vec<FilterIssue> = Vec::new();
    let mut filter = Filter::default();

    for (key, field) in object {
        match key.as_str() {
            "ids" => filter.ids = validate_prefixes("ids", field, &mut issues),
            "authors" => filter.authors = validate_prefixes("authors", field, &mut issues),
            "kinds" => filter.kinds = validate_kinds("kinds", field, &mut issues),
            "since" => filter.since = validate_timestamp("since", field, &mut issues),
            "until" => filter.until = validate_timestamp("until", field, &mut issues),
            "limit" => filter.limit = validate_limit("limit", field, &mut issues),
            "search" => filter.search = validate_search("search", field, &mut issues),
            _ => {
                if let Some(criteria) = validate_string_array(key, field, &mut issues) {
                    filter.tags.insert(key.clone(), criteria);
                }
            }
        }
    }

    // `superRefine`: unknown keys, then the NIP-12 geohash rule.
    for (key, field) in object {
        if !KNOWN_FILTER_KEYS.contains(&key.as_str()) && !is_generic_tag_query(key) {
            issues.push(FilterIssue {
                path: key.clone(),
                message: format!("Unknown key: {key}"),
            });
        }

        if key == "#g"
            && let Value::Array(criteria) = field
        {
            for (index, criterion) in criteria.iter().enumerate() {
                if let Value::String(text) = criterion
                    && !is_geohash_filter_value(text)
                {
                    issues.push(FilterIssue {
                        path: format!("#g[{index}]"),
                        message: "Invalid geohash filter".to_owned(),
                    });
                }
            }
        }
    }

    if issues.is_empty() {
        Ok(filter)
    } else {
        Err(issues)
    }
}

/// Removes deep-equal duplicates, keeping the first occurrence of each
/// (`uniqWith(equals, message.slice(2))`, `src/handlers/subscribe-message-handler.ts:54`).
pub fn dedupe_filters(filters: Vec<Filter>) -> Vec<Filter> {
    let mut unique: Vec<Filter> = Vec::with_capacity(filters.len());

    for filter in filters {
        if !unique.contains(&filter) {
            unique.push(filter);
        }
    }

    unique
}

/// The REQ handler's normalisation (`src/handlers/subscribe-message-handler.ts:54-58`):
/// dedupe, then drop `search` from every filter when NIP-50 is disabled. Nothing else
/// normalises — no key sorting, no default limit, no prefix lowering.
pub fn normalise_subscription(filters: Vec<Filter>, search_enabled: bool) -> Vec<Filter> {
    let mut filters = dedupe_filters(filters);

    if !search_enabled {
        for filter in &mut filters {
            filter.search = None;
        }
    }

    filters
}

/// The zod type error for `value` where `expected` was required
/// (`Expected array, received null`).
fn invalid_type(expected: &str, value: &Value) -> String {
    let received = match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    };

    format!("Expected {expected}, received {received}")
}

fn issue(path: &str, message: impl Into<String>, issues: &mut Vec<FilterIssue>) {
    issues.push(FilterIssue {
        path: path.to_owned(),
        message: message.into(),
    });
}

/// `z.array(prefixSchema)`: lowercase hex prefixes of 4..=64 characters.
fn validate_prefixes(
    path: &str,
    value: &Value,
    issues: &mut Vec<FilterIssue>,
) -> Option<Vec<String>> {
    let Value::Array(items) = value else {
        issue(path, invalid_type("array", value), issues);
        return None;
    };

    let mut prefixes = Vec::with_capacity(items.len());

    for (index, item) in items.iter().enumerate() {
        let element = format!("{path}[{index}]");
        let Value::String(text) = item else {
            issue(&element, invalid_type("string", item), issues);
            continue;
        };

        let mut valid = true;

        if text.is_empty()
            || !text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            issue(&element, "Invalid", issues);
            valid = false;
        }

        // zod's `.min()`/`.max()` count UTF-16 code units, as `String.prototype.length` does:
        // an astral character is two of them.
        let length = text.encode_utf16().count();

        if length < 4 {
            issue(
                &element,
                "String must contain at least 4 character(s)",
                issues,
            );
            valid = false;
        }

        if length > 64 {
            issue(
                &element,
                "String must contain at most 64 character(s)",
                issues,
            );
            valid = false;
        }

        if valid {
            prefixes.push(text.clone());
        }
    }

    Some(prefixes)
}

/// `z.array(kindSchema)`: integers `>= 0`.
fn validate_kinds(path: &str, value: &Value, issues: &mut Vec<FilterIssue>) -> Option<Vec<Kind>> {
    let Value::Array(items) = value else {
        issue(path, invalid_type("array", value), issues);
        return None;
    };

    let mut kinds = Vec::with_capacity(items.len());

    for (index, item) in items.iter().enumerate() {
        let element = format!("{path}[{index}]");
        let Some(number) = item.as_f64() else {
            issue(&element, invalid_type("number", item), issues);
            continue;
        };

        let mut valid = true;

        if number.fract() != 0.0 {
            issue(&element, "Expected integer, received float", issues);
            valid = false;
        }

        if number < 0.0 {
            issue(
                &element,
                "Number must be greater than or equal to 0",
                issues,
            );
            valid = false;
        }

        if !valid {
            continue;
        }

        // Representability, not a zod rule: the capture holds kinds as JavaScript numbers.
        // A JSON integer that fits `u64` is carried exactly — `as_f64` would round
        // `u64::MAX` up to `2^64` and refuse a value this can hold — and only a value no
        // `u64` can hold is refused rather than saturated (ADR 0002).
        match item.as_u64() {
            Some(kind) => kinds.push(Kind(kind)),
            None if number >= U64_RANGE_END => {
                issue(&element, KIND_DOES_NOT_FIT, issues);
            }
            None => kinds.push(Kind(number as u64)),
        }
    }

    Some(kinds)
}

/// `createdAtSchema`: integers `>= 0` below `10^10` (`src/schemas/base-schema.ts:25-30`), the
/// window `validation::CREATED_AT_LIMIT` holds for this check and the decoder's `created_at`.
fn validate_timestamp(path: &str, value: &Value, issues: &mut Vec<FilterIssue>) -> Option<i64> {
    let Some(number) = value.as_f64() else {
        issue(path, invalid_type("number", value), issues);
        return None;
    };

    let mut valid = true;

    if number.fract() != 0.0 {
        issue(path, "Expected integer, received float", issues);
        valid = false;
    }

    if number < 0.0 {
        issue(path, "Number must be greater than or equal to 0", issues);
        valid = false;
    }

    let safe_integer = number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER;
    let in_range = safe_integer && (0.0..CREATED_AT_LIMIT as f64).contains(&number);

    if !in_range {
        issue(path, "Invalid timestamp", issues);
        valid = false;
    }

    if valid { Some(number as i64) } else { None }
}

/// `z.number().int().min(0)` for `limit`, whose representability refusal is ADR 0002's
/// (`docs/rewrite/decisions/0002-core-crypto-and-negentropy.md:125-136`).
fn validate_limit(path: &str, value: &Value, issues: &mut Vec<FilterIssue>) -> Option<u64> {
    let Some(number) = value.as_f64() else {
        issue(path, invalid_type("number", value), issues);
        return None;
    };

    let mut valid = true;

    if number.fract() != 0.0 {
        issue(path, "Expected integer, received float", issues);
        valid = false;
    }

    if number < 0.0 {
        issue(path, "Number must be greater than or equal to 0", issues);
        valid = false;
    }

    if !valid {
        return None;
    }

    // See `validate_kinds`: a JSON integer that fits `u64` is carried exactly, and only a
    // value no `u64` can hold is refused rather than saturated.
    match value.as_u64() {
        Some(limit) => Some(limit),
        None if number >= U64_RANGE_END => {
            issue(path, "limit does not fit in 64 bits", issues);
            None
        }
        None => Some(number as u64),
    }
}

/// `z.string().min(1).max(1024)` for the NIP-50 query.
fn validate_search(path: &str, value: &Value, issues: &mut Vec<FilterIssue>) -> Option<String> {
    let Value::String(text) = value else {
        issue(path, invalid_type("string", value), issues);
        return None;
    };

    let length = text.encode_utf16().count();
    let mut valid = true;

    if length < 1 {
        issue(path, "String must contain at least 1 character(s)", issues);
        valid = false;
    }

    if length > 1024 {
        issue(
            path,
            "String must contain at most 1024 character(s)",
            issues,
        );
        valid = false;
    }

    if valid { Some(text.clone()) } else { None }
}

/// The catchall, `z.array(z.string().max(1024))`, which is also the tag-criterion shape.
fn validate_string_array(
    path: &str,
    value: &Value,
    issues: &mut Vec<FilterIssue>,
) -> Option<Vec<String>> {
    let Value::Array(items) = value else {
        issue(path, invalid_type("array", value), issues);
        return None;
    };

    let mut strings = Vec::with_capacity(items.len());

    for (index, item) in items.iter().enumerate() {
        let element = format!("{path}[{index}]");
        let Value::String(text) = item else {
            issue(&element, invalid_type("string", item), issues);
            continue;
        };

        if text.encode_utf16().count() > 1024 {
            issue(
                &element,
                "String must contain at most 1024 character(s)",
                issues,
            );
            continue;
        }

        strings.push(text.clone());
    }

    Some(strings)
}

/// `GEOHASH_FILTER_PATTERN`: base32 characters with at most one trailing `*`
/// (`src/utils/geohash.ts:12`).
fn is_geohash_filter_value(value: &str) -> bool {
    let body = value.strip_suffix('*').unwrap_or(value);

    !body.is_empty()
        && body
            .chars()
            .all(|character| GEOHASH_BASE32.contains(character))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::event::Signature;

    const ID: &str = "aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900";
    const PUBKEY: &str = "bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900aa11";

    fn event() -> Event {
        Event {
            id: ID.parse().unwrap(),
            pubkey: PUBKEY.parse().unwrap(),
            created_at: 1000,
            kind: Kind::TEXT_NOTE,
            tags: Vec::new(),
            content: String::new(),
            sig: Signature::from_byte_array([0; 64]),
        }
    }

    #[test]
    fn tag_map_keeps_the_hash_in_each_key() {
        let document = r##"{"#e":["aa"]}"##;

        let filter: Filter = serde_json::from_str(document).unwrap();

        assert_eq!(filter.tags.get("#e"), Some(&vec!["aa".to_owned()]));
        assert_eq!(serde_json::to_string(&filter).unwrap(), document);
    }

    #[test]
    fn tag_map_round_trips_every_documented_key() {
        let document = r##"{"#a":["30023:pk:d"],"#d":[""],"#e":["aa","bb"],"#p":["cc"]}"##;

        let filter: Filter = serde_json::from_str(document).unwrap();

        assert_eq!(filter.tags.len(), 4);
        assert_eq!(filter.tags["#d"], vec![String::new()]);
        assert_eq!(serde_json::to_string(&filter).unwrap(), document);
    }

    #[test]
    fn validate_filter_and_deserialize_agree_on_a_valid_document() {
        let document = r##"{"ids":["aaaa"],"authors":["bbbb"],"kinds":[0,1],"since":10,"until":20,"limit":5,"search":"nostr","#e":["aa"]}"##;
        let value: Value = serde_json::from_str(document).unwrap();

        let validated = validate_filter(&value).unwrap();
        let deserialised: Filter = serde_json::from_str(document).unwrap();

        assert_eq!(validated, deserialised);
    }

    #[test]
    fn validate_filter_reports_the_path_and_message_of_each_issue() {
        let value = serde_json::json!({"kinds": [[10000, 19999]]});

        let issues = validate_filter(&value).unwrap_err();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].path, "kinds[0]");
        assert_eq!(issues[0].message, "Expected number, received array");
        assert_eq!(
            issues[0].to_string(),
            "kinds[0]: Expected number, received array"
        );
    }

    #[test]
    fn validate_filter_builds_the_tag_map_from_the_document() {
        let value = serde_json::json!({"#e": ["aa"], "#t": ["nostr"]});

        let filter = validate_filter(&value).unwrap();

        assert_eq!(filter.tags["#e"], vec!["aa".to_owned()]);
        assert_eq!(filter.tags["#t"], vec!["nostr".to_owned()]);
    }

    #[test]
    fn dedupe_filters_keeps_the_first_of_each_deep_equal_filter() {
        let first: Filter = serde_json::from_str(r#"{"kinds":[1]}"#).unwrap();
        let second: Filter = serde_json::from_str(r#"{"kinds":[2]}"#).unwrap();

        let unique = dedupe_filters(vec![first.clone(), second.clone(), first.clone()]);

        assert_eq!(unique, vec![first, second]);
    }

    #[test]
    fn normalise_subscription_drops_search_when_nip50_is_disabled() {
        let searched: Filter = serde_json::from_str(r#"{"search":"nostr","kinds":[1]}"#).unwrap();
        let plain: Filter = serde_json::from_str(r#"{"kinds":[2]}"#).unwrap();

        let normalised = normalise_subscription(vec![searched.clone(), plain.clone()], false);

        assert_eq!(normalised.len(), 2);
        assert_eq!(normalised[0].search, None);
        assert_eq!(normalised[0].kinds, searched.kinds);
        assert_eq!(
            normalise_subscription(vec![searched], true)[0]
                .search
                .as_deref(),
            Some("nostr")
        );
    }

    #[test]
    fn normalise_subscription_changes_nothing_else() {
        let filter: Filter = serde_json::from_str(r#"{"ids":["aaaa"],"limit":7}"#).unwrap();

        assert_eq!(
            normalise_subscription(vec![filter.clone()], true),
            vec![filter]
        );
    }

    #[test]
    fn generic_tag_queries_are_one_letter_after_the_hash() {
        assert!(is_generic_tag_query("#e"));
        assert!(is_generic_tag_query("#A"));
        assert!(!is_generic_tag_query("#0"));
        assert!(!is_generic_tag_query("#ee"));
        assert!(!is_generic_tag_query("e"));
    }

    #[test]
    fn hex_prefixes_are_case_sensitive_and_length_bound() {
        let bytes = [0xaa, 0xbb];

        assert!(hex_prefix_matches(&bytes, ""));
        assert!(hex_prefix_matches(&bytes, "a"));
        assert!(hex_prefix_matches(&bytes, "aabb"));
        assert!(!hex_prefix_matches(&bytes, "aabbc"));
        assert!(!hex_prefix_matches(&bytes, "AA"));
        assert!(!hex_prefix_matches(&bytes, "zz"));
    }

    #[test]
    fn matcher_ignores_keys_that_are_not_generic_tag_queries() {
        let filter: Filter = serde_json::from_str(r##"{"#expiration":["nothing"]}"##).unwrap();

        assert!(filter.matches(&event()));
    }

    #[test]
    fn matcher_requires_every_tag_criterion_to_match_one_tag() {
        let mut event = event();
        event.tags = vec![vec!["e".to_owned(), "aa".to_owned()]];
        let matching: Filter = serde_json::from_str(r##"{"#e":["aa"]}"##).unwrap();
        let not_matching: Filter = serde_json::from_str(r##"{"#e":["zz"]}"##).unwrap();

        assert!(matching.matches(&event));
        assert!(!not_matching.matches(&event));
    }

    #[test]
    fn matcher_treats_since_and_until_as_inclusive() {
        assert!(
            serde_json::from_str::<Filter>(r#"{"since":1000}"#)
                .unwrap()
                .matches(&event())
        );
        assert!(
            serde_json::from_str::<Filter>(r#"{"until":1000}"#)
                .unwrap()
                .matches(&event())
        );
        assert!(
            !serde_json::from_str::<Filter>(r#"{"since":1001}"#)
                .unwrap()
                .matches(&event())
        );
        assert!(
            !serde_json::from_str::<Filter>(r#"{"until":999}"#)
                .unwrap()
                .matches(&event())
        );
    }

    #[test]
    fn matcher_search_is_case_insensitive_and_substring_based() {
        let mut event = event();
        event.content = "Bitcoin and Lightning".to_owned();

        for query in ["bitcoin", "BITCOIN", "bitcoin lightning", ""] {
            let filter: Filter =
                serde_json::from_str(&format!(r#"{{"search":"{query}"}}"#)).unwrap();
            assert!(filter.matches(&event), "{query}");
        }

        for query in ["ethereum", "bitcoin ethereum", "   "] {
            let filter: Filter =
                serde_json::from_str(&format!(r#"{{"search":"{query}"}}"#)).unwrap();
            assert!(!filter.matches(&event), "{query}");
        }
    }

    #[test]
    fn matcher_compares_the_geohash_prefix_only_for_g() {
        let mut event = event();
        event.tags = vec![vec!["g".to_owned(), "u4pruydqqvj".to_owned()]];

        let wildcard: Filter = serde_json::from_str(r##"{"#g":["u4pruyd*"]}"##).unwrap();
        let exact_prefix: Filter = serde_json::from_str(r##"{"#g":["u4pruyd"]}"##).unwrap();
        let exact: Filter = serde_json::from_str(r##"{"#g":["u4pruydqqvj"]}"##).unwrap();
        let other_tag: Filter = serde_json::from_str(r##"{"#e":["u4pruyd*"]}"##).unwrap();

        assert!(wildcard.matches(&event));
        assert!(!exact_prefix.matches(&event));
        assert!(exact.matches(&event));
        assert!(!other_tag.matches(&event));
    }

    #[test]
    fn matcher_never_matches_an_empty_array_criterion() {
        let mut event = event();
        event.tags = vec![vec!["e".to_owned(), "aa".to_owned()]];

        for document in [
            r#"{"ids":[]}"#,
            r#"{"authors":[]}"#,
            r#"{"kinds":[]}"#,
            r##"{"#e":[]}"##,
        ] {
            let filter: Filter = serde_json::from_str(document).unwrap();
            assert!(!filter.matches(&event), "{document}");
        }
    }

    #[test]
    fn value_count_sums_every_array_criterion() {
        let filter: Filter = serde_json::from_str(
            r##"{"ids":["aa"],"authors":["bb","cc"],"kinds":[1,2,3],"#e":["x"],"since":1,"search":"aa bb"}"##,
        )
        .unwrap();

        assert_eq!(filter.value_count(), 7);
        assert_eq!(Filter::default().value_count(), 0);
    }

    #[test]
    fn filter_hash_is_stable_for_equal_documents() {
        use std::collections::HashSet;

        let one: Filter = serde_json::from_str(r#"{"kinds":[1],"since":5}"#).unwrap();
        let two: Filter = serde_json::from_str(r#"{"since":5,"kinds":[1]}"#).unwrap();
        let mut set = HashSet::new();

        set.insert(one);

        assert!(set.contains(&two));
    }
}
