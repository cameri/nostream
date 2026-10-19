//! Event-query composition. Reproduces the SQL semantics of
//! `src/repositories/event-repository.ts` (measured against its unit-test expectations):
//! hex prefix groups, kind/time criteria, NIP-50 search, NIP-56 exclusion, one `EXISTS` per
//! tag name, `UNION` across filters, and the capture's per-branch `ORDER BY`/`LIMIT`.

use nostream_core::Filter;
use sqlx::postgres::PgArguments;
use sqlx::{AssertSqlSafe, Postgres};

use super::{DEFAULT_FILTER_LIMIT, DEFAULT_TS_CONFIG};
use crate::error::StorageError;

/// The columns one stored event row is read from.
const EVENT_COLUMNS: &str = "events.id::text AS id, events.event_id, events.event_pubkey, \
events.event_kind, events.event_created_at, events.event_content, events.event_tags, \
events.event_signature, events.first_seen, events.deleted_at, events.event_deduplication, \
events.remote_address::text AS remote_address, events.expires_at";

/// One bind value. Values are owned by the query, so the stream that drains it borrows only
/// the pool.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Arg {
    Bytes(Vec<u8>),
    BytesList(Vec<Vec<u8>>),
    Text(String),
    TextList(Vec<String>),
    Int(i32),
    BigInt(i64),
    IntList(Vec<i32>),
    Bool(bool),
    Timestamp(chrono::DateTime<chrono::Utc>),
    NaiveTimestamp(chrono::NaiveDateTime),
    Real(f32),
    NullText,
    NullInt,
    NullNaiveTimestamp,
    NullTimestamp,
    NullBytes,
}

impl Arg {
    fn bind(
        self,
        query: sqlx::query::Query<'static, Postgres, PgArguments>,
    ) -> sqlx::query::Query<'static, Postgres, PgArguments> {
        match self {
            Self::Bytes(value) => query.bind(value),
            Self::BytesList(values) => query.bind(values),
            Self::Text(value) => query.bind(value),
            Self::TextList(values) => query.bind(values),
            Self::Int(value) => query.bind(value),
            Self::BigInt(value) => query.bind(value),
            Self::IntList(values) => query.bind(values),
            Self::Bool(value) => query.bind(value),
            Self::Timestamp(value) => query.bind(value),
            Self::NaiveTimestamp(value) => query.bind(value),
            Self::Real(value) => query.bind(value),
            Self::NullText => query.bind(None::<String>),
            Self::NullInt => query.bind(None::<i32>),
            Self::NullNaiveTimestamp => query.bind(None::<chrono::NaiveDateTime>),
            Self::NullTimestamp => query.bind(None::<chrono::DateTime<chrono::Utc>>),
            Self::NullBytes => query.bind(None::<Vec<u8>>),
        }
    }
}

/// The placeholder list one statement's binds are written as `$1..$n`.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Args {
    items: Vec<Arg>,
}

impl Args {
    pub(crate) fn push(&mut self, arg: Arg) -> String {
        self.items.push(arg);
        format!("${}", self.items.len())
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }
}

/// One composed event statement: SQL text plus its bind values, in placeholder order.
#[derive(Debug)]
pub(crate) struct EventQuery {
    pub(crate) sql: String,
    pub(crate) args: Args,
}

impl EventQuery {
    /// Materialises the statement with its binds, ready to fetch.
    pub(crate) fn into_query(self) -> sqlx::query::Query<'static, Postgres, PgArguments> {
        let mut query = sqlx::query(AssertSqlSafe(self.sql));
        for arg in self.args.items {
            query = arg.bind(query);
        }
        query
    }
}

/// The settings gates the capture reads per query.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Gates {
    pub(crate) nip50: Option<Nip50Gate>,
    pub(crate) nip56: bool,
}

/// The resolved NIP-50 configuration (`nip50.{language,maxQueryLength}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Nip50Gate {
    pub(crate) language: String,
    pub(crate) max_query_length: u64,
}

/// Composes `findByFilters`: one branch per filter, `UNION`ed, each keeping its own
/// `ORDER BY`/`LIMIT`, with the first filter's order applied to the union.
pub(crate) fn find_by_filters(
    filters: &[Filter],
    gates: &Gates,
) -> Result<EventQuery, StorageError> {
    if filters.is_empty() {
        return Err(StorageError::InvalidArgument {
            message: "Filters cannot be empty",
        });
    }

    let mut builder = Builder::default();
    if filters.len() == 1 {
        push_event_branch(&mut builder, &filters[0], gates);
    } else {
        for (index, filter) in filters.iter().enumerate() {
            if index > 0 {
                builder.push(" UNION ");
            }
            builder.push("(");
            push_event_branch(&mut builder, filter, gates);
            builder.push(")");
        }
        push_order(&mut builder, &filters[0], is_search(&filters[0], gates));
    }

    Ok(builder.finish())
}

/// Composes `countByFilters`: the union of the filters' live ids, counted.
pub(crate) fn count_by_filters(
    filters: &[Filter],
    gates: &Gates,
    now: i64,
) -> Result<EventQuery, StorageError> {
    if filters.is_empty() {
        return Err(StorageError::InvalidArgument {
            message: "Filters cannot be empty",
        });
    }

    let mut builder = Builder::default();
    builder.push("SELECT count(*) AS count FROM (");
    if filters.len() == 1 {
        push_id_branch(&mut builder, &filters[0], gates, now);
    } else {
        for (index, filter) in filters.iter().enumerate() {
            if index > 0 {
                builder.push(" UNION ");
            }
            builder.push("(");
            push_id_branch(&mut builder, filter, gates, now);
            builder.push(")");
        }
    }
    builder.push(") AS matching_events");

    Ok(builder.finish())
}

/// Composes `findReconciliationItems`: the filter's live `(created_at, event_id)` pairs,
/// oldest first, with the filter's limit ignored.
pub(crate) fn find_reconciliation_items(
    filter: &Filter,
    gates: &Gates,
    now: i64,
) -> Result<EventQuery, StorageError> {
    let mut builder = Builder::default();
    builder.push("SELECT events.event_created_at, events.event_id FROM events WHERE 1 = 1");
    push_conditions(&mut builder, filter, gates);
    push_live_only(&mut builder, now);
    builder.push(" ORDER BY event_created_at ASC, event_id ASC");

    Ok(builder.finish())
}

#[derive(Debug, Default)]
struct Builder {
    sql: String,
    args: Args,
}

impl Builder {
    fn push(&mut self, text: &str) {
        self.sql.push_str(text);
    }

    fn arg(&mut self, arg: Arg) -> String {
        self.args.push(arg)
    }

    fn finish(self) -> EventQuery {
        EventQuery {
            sql: self.sql,
            args: self.args,
        }
    }
}

fn push_event_branch(builder: &mut Builder, filter: &Filter, gates: &Gates) {
    builder.push("SELECT ");
    builder.push(EVENT_COLUMNS);

    let search = is_search(filter, gates);
    if search {
        let (language, query) = search_binding(filter, gates);
        let language_slot = builder.arg(Arg::Text(language.clone()));
        let query_language_slot = builder.arg(Arg::Text(language));
        let query_slot = builder.arg(Arg::Text(query));
        builder.push(&format!(
            ", ts_rank(to_tsvector({language_slot}::regconfig, events.event_content), \
plainto_tsquery({query_language_slot}::regconfig, {query_slot})) AS search_rank"
        ));
    }

    builder.push(" FROM events WHERE 1 = 1");
    push_conditions(builder, filter, gates);

    let limit = filter.limit.unwrap_or(DEFAULT_FILTER_LIMIT);
    push_order(builder, filter, search);
    let limit_slot = builder.arg(Arg::BigInt(limit as i64));
    builder.push(&format!(" LIMIT {limit_slot}"));
}

fn push_id_branch(builder: &mut Builder, filter: &Filter, gates: &Gates, now: i64) {
    builder.push("SELECT events.event_id FROM events WHERE 1 = 1");
    push_conditions(builder, filter, gates);
    push_live_only(builder, now);
    if filter.limit.is_some() {
        push_order(builder, filter, false);
        let limit_slot = builder.arg(Arg::BigInt(filter.limit.unwrap_or_default() as i64));
        builder.push(&format!(" LIMIT {limit_slot}"));
    }
}

fn push_live_only(builder: &mut Builder, now: i64) {
    let now_slot = builder.arg(Arg::BigInt(now));
    builder.push(&format!(
        " AND (events.deleted_at IS NULL AND (events.expires_at IS NULL OR events.expires_at > {now_slot}))"
    ));
}

fn push_order(builder: &mut Builder, filter: &Filter, search: bool) {
    if search {
        builder.push(" ORDER BY search_rank DESC, event_id ASC");
    } else if filter.limit.is_some() {
        builder.push(" ORDER BY event_created_at DESC, event_id ASC");
    } else {
        builder.push(" ORDER BY event_created_at ASC, event_id ASC");
    }
}

fn push_conditions(builder: &mut Builder, filter: &Filter, gates: &Gates) {
    if let Some(authors) = &filter.authors {
        push_hex_criteria(builder, "events.event_pubkey", authors);
    }
    if let Some(ids) = &filter.ids {
        push_hex_criteria(builder, "events.event_id", ids);
    }

    if gates.nip56 {
        builder.push(
            " AND NOT EXISTS (SELECT 1 FROM reports WHERE reports.actionable = true AND \
(reports.reported_event_id = events.event_id OR reports.reported_pubkey = events.event_pubkey))",
        );
    }

    if let Some(kinds) = &filter.kinds {
        let kinds: Vec<i32> = kinds
            .iter()
            .map(|kind| i32::try_from(kind.0).unwrap_or(i32::MAX))
            .collect();
        let slot = builder.arg(Arg::IntList(kinds));
        builder.push(&format!(" AND events.event_kind = ANY({slot})"));
    }

    if let Some(since) = filter.since {
        let slot = builder.arg(Arg::BigInt(since));
        builder.push(&format!(" AND events.event_created_at >= {slot}"));
    }

    if let Some(until) = filter.until {
        let slot = builder.arg(Arg::BigInt(until));
        builder.push(&format!(" AND events.event_created_at <= {slot}"));
    }

    if is_search(filter, gates) {
        let (language, query) = search_binding(filter, gates);
        let language_slot = builder.arg(Arg::Text(language.clone()));
        let query_language_slot = builder.arg(Arg::Text(language));
        let query_slot = builder.arg(Arg::Text(query));
        builder.push(&format!(
            " AND (to_tsvector({language_slot}::regconfig, events.event_content) @@ \
plainto_tsquery({query_language_slot}::regconfig, {query_slot}))"
        ));
    }

    for (key, criteria) in &filter.tags {
        let Some(name) = generic_tag_name(key) else {
            continue;
        };

        if criteria.is_empty() {
            builder.push(" AND 1 = 0");
            continue;
        }

        let mut values = Vec::new();
        let mut prefixes = Vec::new();
        for criterion in criteria {
            match strip_geohash_prefix(key, criterion) {
                Some(prefix) => prefixes.push(prefix.to_owned()),
                None => values.push(criterion.clone()),
            }
        }

        let name_slot = builder.arg(Arg::Text(name.to_owned()));
        builder.push(&format!(
            " AND EXISTS (SELECT 1 FROM event_tags WHERE event_tags.event_id = events.event_id \
AND event_tags.tag_name = {name_slot} AND ("
        ));

        let mut parts = Vec::new();
        if !values.is_empty() {
            let values_slot = builder.arg(Arg::TextList(values));
            parts.push(format!("event_tags.tag_value = ANY({values_slot})"));
        }
        for prefix in prefixes {
            let prefix_slot = builder.arg(Arg::Text(format!("{prefix}%")));
            parts.push(format!("event_tags.tag_value LIKE {prefix_slot}"));
        }
        builder.push(&parts.join(" OR "));
        builder.push("))");
    }
}

/// One hex criterion family: 64 characters compare exactly, an even-length prefix compares
/// its bytes, an odd-length one compares a byte range. Groups are OR-ed; an empty list
/// matches nothing.
fn push_hex_criteria(builder: &mut Builder, column: &str, criteria: &[String]) {
    if criteria.is_empty() {
        builder.push(" AND 1 = 0");
        return;
    }

    let mut exact = Vec::new();
    let mut even = Vec::new();
    let mut odd = Vec::new();
    for criterion in criteria {
        match criterion.len() {
            64 => exact.push(criterion.clone()),
            length if length % 2 == 0 => even.push(criterion.clone()),
            _ => odd.push(criterion.clone()),
        }
    }

    let mut parts = Vec::new();
    if !exact.is_empty() {
        let bytes: Vec<Vec<u8>> = exact.iter().map(|value| hex_bytes(value)).collect();
        let slot = builder.arg(Arg::BytesList(bytes));
        parts.push(format!("{column} = ANY({slot})"));
    }
    for prefix in even {
        let length_slot = builder.arg(Arg::Int((prefix.len() >> 1) as i32));
        let bytes = builder.arg(Arg::Bytes(hex_bytes(&prefix)));
        parts.push(format!(
            "substring({column} from 1 for {length_slot}) = {bytes}"
        ));
    }
    for prefix in odd {
        let length_slot = builder.arg(Arg::Int(((prefix.len() >> 1) + 1) as i32));
        let low = builder.arg(Arg::Bytes(hex_bytes(&format!("{prefix}0"))));
        let high = builder.arg(Arg::Bytes(hex_bytes(&format!("{prefix}f"))));
        parts.push(format!(
            "substring({column} from 1 for {length_slot}) BETWEEN {low} AND {high}"
        ));
    }

    builder.push(&format!(" AND ({})", parts.join(" OR ")));
}

/// The capture's `isGenericTagQuery`: `#` plus one ASCII letter.
fn generic_tag_name(key: &str) -> Option<&str> {
    let mut characters = key.chars();
    if characters.next() != Some('#') {
        return None;
    }
    let name = characters.next()?;
    if characters.next().is_some() || !name.is_ascii_alphabetic() {
        return None;
    }
    Some(&key[1..2])
}

/// `isGeohashPrefixCriterion`: only `#g` criteria may end in `*`, and only those are
/// prefixes. Returns the prefix without the wildcard.
fn strip_geohash_prefix<'a>(key: &str, criterion: &'a str) -> Option<&'a str> {
    if key == "#g" && criterion.ends_with('*') {
        criterion.strip_suffix('*')
    } else {
        None
    }
}

fn is_search(filter: &Filter, gates: &Gates) -> bool {
    gates.nip50.is_some()
        && filter
            .search
            .as_deref()
            .is_some_and(|search| !search.trim().is_empty())
}

fn search_binding(filter: &Filter, gates: &Gates) -> (String, String) {
    let Some(gate) = &gates.nip50 else {
        return (DEFAULT_TS_CONFIG.to_owned(), String::new());
    };
    let query = filter.search.as_deref().unwrap_or_default().trim();
    let query = query
        .chars()
        .take(gate.max_query_length as usize)
        .collect::<String>();
    (gate.language.clone(), query)
}

/// Hex helpers, kept local so the query composer needs no hex crate dependency.
pub(crate) fn hex_bytes(value: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(value.len() / 2);
    let digits = value.as_bytes();
    let mut index = 0;
    while index + 1 < digits.len() {
        let high = hex_digit(digits[index]);
        let low = hex_digit(digits[index + 1]);
        bytes.push((high << 4) | low);
        index += 2;
    }
    bytes
}

fn hex_digit(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        b'A'..=b'F' => digit - b'A' + 10,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use nostream_core::Kind;

    fn filter() -> Filter {
        Filter::default()
    }

    fn gates(nip50: bool, nip56: bool) -> Gates {
        Gates {
            nip50: nip50.then(|| Nip50Gate {
                language: "simple".to_owned(),
                max_query_length: 256,
            }),
            nip56,
        }
    }

    fn sql(query: &EventQuery) -> &str {
        &query.sql
    }

    #[test]
    fn no_filters_is_the_capture_error() {
        let error = find_by_filters(&[], &gates(false, false)).expect_err("empty filters");
        assert!(matches!(
            error,
            StorageError::InvalidArgument {
                message: "Filters cannot be empty"
            }
        ));
        let error = count_by_filters(&[], &gates(false, false), 0).expect_err("empty filters");
        assert!(matches!(error, StorageError::InvalidArgument { .. }));
    }

    #[test]
    fn one_filter_defaults_to_500_rows_oldest_first() {
        let query = find_by_filters(&[filter()], &gates(false, false)).unwrap();
        assert!(sql(&query).contains("ORDER BY event_created_at ASC, event_id ASC LIMIT $1"));
        assert_eq!(query.args.len(), 1);
    }

    #[test]
    fn a_limited_filter_orders_newest_first() {
        let mut filter = filter();
        filter.limit = Some(10);
        let query = find_by_filters(&[filter], &gates(false, false)).unwrap();
        assert!(sql(&query).contains("ORDER BY event_created_at DESC, event_id ASC LIMIT $1"));
        assert_eq!(
            query.args,
            Args {
                items: vec![Arg::BigInt(10)]
            }
        );
    }

    #[test]
    fn exact_even_and_odd_author_prefixes_become_one_or_group() {
        let mut filter = filter();
        filter.authors = Some(vec!["a".repeat(64), "abcd".to_owned(), "abcde".to_owned()]);
        let query = find_by_filters(&[filter], &gates(false, false)).unwrap();
        let text = sql(&query);
        assert!(text.contains("events.event_pubkey = ANY($1)"));
        assert!(text.contains("substring(events.event_pubkey from 1 for $2) = $3"));
        assert!(text.contains("substring(events.event_pubkey from 1 for $4) BETWEEN $5 AND $6"));
        assert_eq!(query.args.len(), 7);
    }

    #[test]
    fn an_empty_id_list_matches_nothing() {
        let mut filter = filter();
        filter.ids = Some(Vec::new());
        let query = find_by_filters(&[filter], &gates(false, false)).unwrap();
        assert!(sql(&query).contains("AND 1 = 0"));
    }

    #[test]
    fn kinds_and_times_are_inclusive() {
        let mut filter = filter();
        filter.kinds = Some(vec![Kind::TEXT_NOTE, Kind(30_023)]);
        filter.since = Some(100);
        filter.until = Some(200);
        let query = find_by_filters(&[filter], &gates(false, false)).unwrap();
        let text = sql(&query);
        assert!(text.contains("events.event_kind = ANY($1)"));
        assert!(text.contains("events.event_created_at >= $2"));
        assert!(text.contains("events.event_created_at <= $3"));
        assert_eq!(
            query.args,
            Args {
                items: vec![
                    Arg::IntList(vec![1, 30_023]),
                    Arg::BigInt(100),
                    Arg::BigInt(200),
                    Arg::BigInt(500)
                ]
            }
        );
    }

    #[test]
    fn search_is_gated_and_changes_the_order() {
        let mut filter = filter();
        filter.search = Some("  bitcoin lightning  ".to_owned());
        let without = find_by_filters(&[filter.clone()], &gates(false, false)).unwrap();
        assert!(!sql(&without).contains("ts_rank"));

        let with = find_by_filters(&[filter], &gates(true, false)).unwrap();
        let text = sql(&with);
        assert!(text.contains("ts_rank(to_tsvector($1::regconfig, events.event_content)"));
        assert!(text.contains("to_tsvector($4::regconfig, events.event_content) @@"));
        assert!(text.contains("ORDER BY search_rank DESC, event_id ASC"));
        assert_eq!(
            with.args,
            Args {
                items: vec![
                    Arg::Text("simple".to_owned()),
                    Arg::Text("simple".to_owned()),
                    Arg::Text("bitcoin lightning".to_owned()),
                    Arg::Text("simple".to_owned()),
                    Arg::Text("simple".to_owned()),
                    Arg::Text("bitcoin lightning".to_owned()),
                    Arg::BigInt(500),
                ]
            }
        );
    }

    #[test]
    fn a_search_query_is_truncated_to_the_configured_length() {
        let mut filter = filter();
        filter.search = Some("a".repeat(300));
        let gate = Gates {
            nip50: Some(Nip50Gate {
                language: "english".to_owned(),
                max_query_length: 10,
            }),
            nip56: false,
        };
        let query = find_by_filters(&[filter], &gate).unwrap();
        assert!(
            query
                .args
                .items
                .iter()
                .any(|arg| { arg == &Arg::Text("a".repeat(10)) })
        );
        assert!(
            query
                .args
                .items
                .iter()
                .any(|arg| arg == &Arg::Text("english".to_owned()))
        );
    }

    #[test]
    fn tag_criteria_become_one_exists_per_tag_name() {
        let mut filter = filter();
        filter
            .tags
            .insert("#e".to_owned(), vec!["aa".to_owned(), "bb".to_owned()]);
        filter.tags.insert("#p".to_owned(), vec!["cc".to_owned()]);
        let query = find_by_filters(&[filter], &gates(false, false)).unwrap();
        assert_eq!(
            sql(&query)
                .matches("EXISTS (SELECT 1 FROM event_tags")
                .count(),
            2
        );
        assert!(sql(&query).contains("event_tags.tag_name = $1"));
        assert!(sql(&query).contains("event_tags.tag_value = ANY($2)"));
        assert!(sql(&query).contains("event_tags.tag_name = $3"));
        assert!(sql(&query).contains("event_tags.tag_value = ANY($4)"));
    }

    #[test]
    fn a_geohash_wildcard_becomes_a_prefix_match() {
        let mut filter = filter();
        filter.tags.insert(
            "#g".to_owned(),
            vec!["u4pru*".to_owned(), "u4pruydqqvj".to_owned()],
        );
        let query = find_by_filters(&[filter], &gates(false, false)).unwrap();
        let text = sql(&query);
        assert!(text.contains("event_tags.tag_name = $1"));
        assert!(text.contains("event_tags.tag_value = ANY($2)"));
        assert!(text.contains("event_tags.tag_value LIKE $3"));
        assert_eq!(query.args.items[2], Arg::Text("u4pru%".to_owned()));
    }

    #[test]
    fn a_non_hex_tag_key_is_not_a_tag_query() {
        let mut filter = filter();
        filter.tags.insert("#em".to_owned(), vec!["x".to_owned()]);
        let query = find_by_filters(&[filter], &gates(false, false)).unwrap();
        assert!(!sql(&query).contains("FROM event_tags"));
    }

    #[test]
    fn nip56_excludes_actionable_reports() {
        let query = find_by_filters(&[filter()], &gates(false, true)).unwrap();
        assert!(sql(&query).contains("NOT EXISTS (SELECT 1 FROM reports"));
        let without = find_by_filters(&[filter()], &gates(false, false)).unwrap();
        assert!(!sql(&without).contains("reports"));
    }

    #[test]
    fn several_filters_are_union_ed_with_the_first_order_on_the_outside() {
        let mut first = filter();
        first.limit = Some(2);
        let mut second = filter();
        second.kinds = Some(vec![Kind::TEXT_NOTE]);
        let query = find_by_filters(&[first, second], &gates(false, false)).unwrap();
        let text = sql(&query);
        assert_eq!(text.matches(" UNION ").count(), 1);
        assert!(text.starts_with("(SELECT "));
        assert!(text.ends_with(") ORDER BY event_created_at DESC, event_id ASC"));
    }

    #[test]
    fn counting_wraps_the_union_in_a_count() {
        let mut first = filter();
        first.limit = Some(3);
        let mut second = filter();
        second.since = Some(5);
        let query = count_by_filters(&[first, second], &gates(false, false), 42).unwrap();
        let text = sql(&query);
        assert!(text.starts_with("SELECT count(*) AS count FROM ("));
        assert!(text.ends_with(") AS matching_events"));
        assert!(text.contains("events.deleted_at IS NULL"));
        assert!(text.contains("events.expires_at > $1"));
        assert_eq!(
            text.matches("ORDER BY event_created_at DESC, event_id ASC LIMIT")
                .count(),
            1
        );
        assert!(text.contains("events.event_created_at >= $3"));
    }

    #[test]
    fn reconciliation_ignores_the_limit_and_excludes_dead_rows() {
        let mut filter = filter();
        filter.limit = Some(7);
        let query = find_reconciliation_items(&filter, &gates(false, false), 42).unwrap();
        let text = sql(&query);
        assert!(!text.contains("LIMIT"));
        assert!(text.contains("events.deleted_at IS NULL"));
        assert!(text.contains("ORDER BY event_created_at ASC, event_id ASC"));
    }

    #[test]
    fn hex_helper_decodes_the_wire_form() {
        assert_eq!(hex_bytes("00ff10"), vec![0x00, 0xff, 0x10]);
        assert_eq!(hex_bytes("ab"), vec![0xab]);
    }
}
