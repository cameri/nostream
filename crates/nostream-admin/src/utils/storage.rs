//! The storage-count query parser and its filters. Mirrors `src/utils/admin-ops-storage.ts`.

use nostream_core::Filter;

/// `ADMIN_OPS_STORAGE_MAX_KINDS`.
pub const MAX_KINDS: usize = 20;

/// `ADMIN_OPS_STORAGE_MAX_WINDOW_SECONDS` — 90 days.
pub const MAX_WINDOW_SECONDS: i64 = 90 * 86_400;

/// `ADMIN_OPS_STORAGE_QUERY_TIMEOUT_MS`.
pub const QUERY_TIMEOUT_MS: u64 = 5_000;

/// The default window when neither bound is given: the last 86,400 s.
pub const DEFAULT_WINDOW_SECONDS: i64 = 86_400;

/// A parsed `GET /ops/storage/counts` query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageQuery {
    pub kinds: Vec<u64>,
    pub since: i64,
    pub until: i64,
}

/// `parseAdminOpsStorageQuery`: the capture's messages, byte for byte.
pub fn parse_query(
    raw_kinds: Option<&str>,
    raw_since: Option<&str>,
    raw_until: Option<&str>,
    now_seconds: i64,
) -> Result<StorageQuery, String> {
    let Some(raw_kinds) = raw_kinds.filter(|kinds| !kinds.trim().is_empty()) else {
        return Err("kinds query parameter is required (comma-separated event kinds)".to_owned());
    };

    let mut kinds: Vec<u64> = Vec::new();
    for part in raw_kinds
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let kind = part.parse::<i64>().map_err(|_| kinds_message())?;
        if !(0..=65_535).contains(&kind) {
            return Err(kinds_message());
        }
        kinds.push(u64::try_from(kind).unwrap_or(0));
    }
    if kinds.is_empty() {
        return Err(kinds_message());
    }
    if kinds.len() > MAX_KINDS {
        return Err(format!("at most {MAX_KINDS} kinds are allowed per request"));
    }
    let mut unique: Vec<u64> = Vec::new();
    for kind in kinds {
        if !unique.contains(&kind) {
            unique.push(kind);
        }
    }

    let since = parse_timestamp(raw_since, "since")?;
    let until = parse_timestamp(raw_until, "until")?;

    let effective_until = until.unwrap_or(now_seconds);
    let effective_since = since.unwrap_or(effective_until - DEFAULT_WINDOW_SECONDS);

    if effective_since > effective_until {
        return Err("since must be less than or equal to until".to_owned());
    }
    if effective_until - effective_since > MAX_WINDOW_SECONDS {
        return Err(format!(
            "time window must not exceed {MAX_WINDOW_SECONDS} seconds"
        ));
    }

    Ok(StorageQuery {
        kinds: unique,
        since: effective_since,
        until: effective_until,
    })
}

fn kinds_message() -> String {
    "kinds must be a comma-separated list of integers between 0 and 65535".to_owned()
}

fn parse_timestamp(raw: Option<&str>, label: &str) -> Result<Option<i64>, String> {
    match raw {
        None | Some("") => Ok(None),
        Some(value) => match value.parse::<i64>() {
            Ok(timestamp) if timestamp >= 0 => Ok(Some(timestamp)),
            _ => Err(format!(
                "{label} must be a non-negative unix timestamp in seconds"
            )),
        },
    }
}

/// `buildStorageCountFilters`: one filter per kind, each carrying the window.
pub fn build_filters(query: &StorageQuery) -> Vec<Filter> {
    query
        .kinds
        .iter()
        .map(|kind| Filter {
            since: Some(query.since),
            until: Some(query.until),
            kinds: Some(vec![nostream_core::Kind(*kind)]),
            ..Filter::default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const NOW: i64 = 1_700_000_000;

    #[test]
    fn kinds_are_required() {
        assert!(parse_query(None, None, None, NOW).is_err());
        assert!(parse_query(Some("  "), None, None, NOW).is_err());
    }

    #[test]
    fn twenty_kinds_are_accepted_and_twenty_one_are_not() {
        let twenty: Vec<String> = (0..20).map(|kind| kind.to_string()).collect();
        assert!(parse_query(Some(&twenty.join(",")), None, None, NOW).is_ok());
        let twenty_one: Vec<String> = (0..21).map(|kind| kind.to_string()).collect();
        let error = parse_query(Some(&twenty_one.join(",")), None, None, NOW).unwrap_err();
        assert_eq!(error, "at most 20 kinds are allowed per request");
    }

    #[test]
    fn a_kind_out_of_range_is_refused() {
        assert!(parse_query(Some("65536"), None, None, NOW).is_err());
        assert!(parse_query(Some("-1"), None, None, NOW).is_err());
    }

    #[test]
    fn the_default_window_is_the_last_day() {
        let query = parse_query(Some("1,2,2"), None, None, NOW).unwrap();
        assert_eq!(query.kinds, vec![1, 2]);
        assert_eq!(query.until, NOW);
        assert_eq!(query.since, NOW - DEFAULT_WINDOW_SECONDS);
    }

    #[test]
    fn a_window_wider_than_ninety_days_is_refused() {
        let until = NOW;
        let since = until - MAX_WINDOW_SECONDS - 1;
        let error = parse_query(
            Some("1"),
            Some(&since.to_string()),
            Some(&until.to_string()),
            NOW,
        )
        .unwrap_err();
        assert!(error.starts_with("time window must not exceed"));
    }

    #[test]
    fn since_after_until_is_refused() {
        let error = parse_query(Some("1"), Some("200"), Some("100"), NOW).unwrap_err();
        assert_eq!(error, "since must be less than or equal to until");
    }
}
