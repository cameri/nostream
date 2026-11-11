//! NIP-50 over the embedded store: the term index, the tokeniser both directions share, the
//! proximity rank, and the rebuild that gives a store written before this module existed its
//! index on its next open.
//!
//! The index is `events_by_term`, keyed `term ‖ event_id` with an empty value, so one term's
//! postings are one byte range in id order. It is maintained on every write path, whether or not
//! the NIP-50 gate is on, because the gate is a read gate: a store written with the feature off
//! answers a search the moment it is turned on.
//!
//! The index narrows candidates; it never decides. A query term finds the postings its key
//! holds, and the row's own body answers whether the term is *the* token or merely shares the
//! key — two tokens that share their first [`SEARCH_TERM_MAX_LEN`] bytes are one key and two
//! verdicts. `docs/rewrite/decisions/0012-nip50-search-index.md` records the decisions (D1–D8):
//! the index's shape, the tokeniser, the candidate-then-body predicate, the ranker and its
//! divergence from `ts_rank`, the marker, the rebuild on open, the gate-off rules, and the
//! language guard. ADR 0011 keeps the store these live in.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::ops::Bound;

use heed::{Env, RoTxn, RwTxn};
use nostream_core::{EventId, Filter};

use super::encoding;
use super::events::Matcher;
use super::rows;
use super::{Databases, Gates};
use crate::error::StorageError;
use crate::repositories::EventRecord;

/// The name of the term index database: `term ‖ event_id`, value empty, one posting per key.
pub const SEARCH_INDEX_DB: &str = "events_by_term";

/// The version of the index's contents, written into `meta` under [`SEARCH_INDEX_MARKER`] after
/// a rebuild. A store whose marker holds another value is rebuilt on the next open.
pub const SEARCH_INDEX_VERSION: u8 = 1;

/// The `meta` key that records [`SEARCH_INDEX_VERSION`].
pub const SEARCH_INDEX_MARKER: &[u8] = b"search-index-version";

/// The one text-search configuration this index reproduces: Postgres' `simple`, which has no
/// stemmer and no stop list, so a token is a token and `the` is an ordinary word.
pub(crate) const SEARCH_LANGUAGE: &str = "simple";

/// How many bytes of a term a key carries. A longer token is truncated on a `char` boundary, so
/// the index can only ever hold more candidates than the body accepts, never fewer.
pub(crate) const SEARCH_TERM_MAX_LEN: usize = 64;

/// How many rows one rebuild write transaction indexes.
pub(crate) const SEARCH_REINDEX_BATCH: usize = 1000;

/// The default `nip50.maxQueryLength` (`src/repositories/event-repository.ts:50-52`).
pub(crate) const DEFAULT_MAX_SEARCH_QUERY_LENGTH: u64 = 256;

/// The message a language the index cannot reproduce is refused with.
const LANGUAGE_REFUSAL: &str =
    "nip50.language must be the simple text-search configuration the lmdb store indexes with";

/// One term index key, as the write path composes it and the walk reads it.
///
/// The term is cut to [`SEARCH_TERM_MAX_LEN`] bytes on a `char` boundary, so two tokens sharing
/// their first 64 bytes are one key; the id tail keeps a term's postings contiguous and in id
/// order, which is what makes the range seekable and its order stable.
fn term_key(term: &str, id: &EventId) -> Vec<u8> {
    let bytes = term_bytes(term);
    let mut key = Vec::with_capacity(bytes.len() + 32);
    key.extend_from_slice(bytes);
    key.extend_from_slice(id.as_bytes());
    key
}

/// The bytes one term occupies in a key, cut to [`SEARCH_TERM_MAX_LEN`] on a `char` boundary.
fn term_bytes(term: &str) -> &[u8] {
    let mut end = 0;
    for (offset, character) in term.char_indices() {
        let next = offset + character.len_utf8();
        if next > SEARCH_TERM_MAX_LEN {
            break;
        }
        end = next;
    }
    &term.as_bytes()[..end]
}

/// The bounds of one term's postings: the term's bytes, then the same bytes followed by the
/// largest possible id. Truncation can only merge two keys, so a query term's range covers every
/// posting a token sharing its prefix wrote.
fn term_range(term: &str) -> (Vec<u8>, Vec<u8>) {
    let bytes = term_bytes(term);
    let mut high = Vec::with_capacity(bytes.len() + 32);
    high.extend_from_slice(bytes);
    high.extend([0xff; 32]);
    (bytes.to_vec(), high)
}

/// The 32-byte id tail of an index key.
fn posting_id(key: &[u8]) -> Result<EventId, StorageError> {
    let Some(id) = key.len().checked_sub(32).and_then(|start| key.get(start..)) else {
        return Err(encoding::invalid(
            SEARCH_INDEX_DB,
            format!("a key of {} bytes", key.len()),
        ));
    };
    encoding::event_id_from(id)
}

/// The tokens one text is searched by: the text lowercased by Unicode case mapping, then split
/// into maximal runs of [`char::is_alphanumeric`] characters, duplicates dropped.
///
/// One statement of the rule, called by the write path that indexes a body and the read path
/// that asks whether a row carries a query's terms, so the index cannot disagree with the
/// predicate about a token. There is no stemming and no stop list, which is `simple`.
pub(crate) fn terms(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    for token in tokens(text) {
        if seen.insert(token.clone()) {
            terms.push(token);
        }
    }
    terms
}

/// The maximal alphanumeric runs of `text`'s lowercase, in the order they occur.
///
/// The lowercase comes first, by Unicode case mapping, because a mapping can turn one character
/// into several: `İ` lowers to `i` and a combining dot, which is not alphanumeric, so `İx` is two
/// tokens here and one if the runs were taken from the original text.
fn tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut run = String::new();
    for character in text.to_lowercase().chars() {
        if character.is_alphanumeric() {
            run.push(character);
        } else if !run.is_empty() {
            tokens.push(std::mem::take(&mut run));
        }
    }
    if !run.is_empty() {
        tokens.push(run);
    }
    tokens
}

/// The terms a filter's search resolves to, or why it cannot be answered.
///
/// `None` is "this filter is not a search": the gate is off, `search` is absent, or it trims to
/// nothing — the read then behaves as it does without the field, which is what Postgres does. An
/// empty list is a search that selects nothing: every token of a punctuation-only query was
/// dropped, which is the empty tsquery `plainto_tsquery` builds for it.
pub(crate) fn query_terms(
    filter: &Filter,
    gates: &Gates,
) -> Result<Option<Vec<String>>, StorageError> {
    if !gates.nip50 {
        return Ok(None);
    }
    let Some(search) = filter.search.as_deref() else {
        return Ok(None);
    };
    let query = search.trim();
    if query.is_empty() {
        return Ok(None);
    }
    if !gates.language_simple {
        return Err(StorageError::InvalidArgument {
            message: LANGUAGE_REFUSAL,
        });
    }
    let limit = usize::try_from(gates.max_query_length).unwrap_or(usize::MAX);
    let query: String = query.chars().take(limit).collect();
    Ok(Some(terms(&query)))
}

/// The rank a body earns for a query's terms, or `None` when the body lacks one of them.
///
/// The rank is the smallest window of consecutive tokens that contains every distinct term, so
/// two adjacent terms rank 2 however far apart their characters are, and a term repeated in the
/// body does not shorten a window the others stretch. Tokens are compared whole: the index may
/// have proposed the row on a shared 64-byte prefix, and only the full tokens decide.
pub(crate) fn verdict(content: &str, terms: &[String]) -> Option<u32> {
    if terms.is_empty() {
        return None;
    }
    let wanted: HashMap<&str, usize> = terms
        .iter()
        .enumerate()
        .map(|(index, term)| (term.as_str(), index))
        .collect();
    let mut hits: Vec<(usize, usize)> = Vec::new();
    for (position, token) in tokens(content).into_iter().enumerate() {
        if let Some(index) = wanted.get(token.as_str()) {
            hits.push((position, *index));
        }
    }

    let mut counts = vec![0usize; terms.len()];
    let mut covered = 0;
    let mut left = 0;
    let mut best: Option<usize> = None;
    for right in 0..hits.len() {
        let (position, term) = hits[right];
        counts[term] += 1;
        if counts[term] == 1 {
            covered += 1;
        }
        while covered == terms.len() {
            let (first, first_term) = hits[left];
            let span = position - first + 1;
            best = Some(best.map_or(span, |kept: usize| kept.min(span)));
            counts[first_term] -= 1;
            if counts[first_term] == 0 {
                covered -= 1;
            }
            left += 1;
        }
    }
    best.map(|span| u32::try_from(span).unwrap_or(u32::MAX))
}

/// Writes one row's postings: one key per distinct token of its content.
///
/// Returns how many keys it wrote, which only the rebuild reports.
pub(crate) fn index_event(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
) -> Result<usize, StorageError> {
    let id = record.event.id;
    let mut written = 0;
    for term in terms(&record.event.content) {
        databases
            .events_by_term
            .put(txn, &term_key(&term, &id), &[])?;
        written += 1;
    }
    Ok(written)
}

/// Removes one row's postings: the same keys [`index_event`] wrote for it.
pub(crate) fn remove_event(
    txn: &mut RwTxn<'_>,
    databases: &Databases,
    record: &EventRecord,
) -> Result<(), StorageError> {
    let id = record.event.id;
    for term in terms(&record.event.content) {
        databases
            .events_by_term
            .delete(txn, &term_key(&term, &id))?;
    }
    Ok(())
}

/// One row the search page keeps, ordered so a max-heap roots at the worst kept row: the largest
/// rank, then the largest id. Popping that root while the heap holds more than the limit leaves
/// the rank-best rows, and [`BinaryHeap::into_sorted_vec`] drains them in the order the page is
/// returned in.
#[derive(Clone, Copy)]
struct SearchKept {
    rank: u32,
    id: EventId,
    created_at: i64,
}

impl Ord for SearchKept {
    fn cmp(&self, other: &Self) -> Ordering {
        self.rank
            .cmp(&other.rank)
            .then_with(|| self.id.cmp(&other.id))
    }
}

impl PartialOrd for SearchKept {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for SearchKept {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for SearchKept {}

/// The page a searched filter returns: the rank-best `limit` rows, in `(rank, event_id)` order.
///
/// The page keeps its own heap because the index's key order is id order and rank order is not —
/// this is the one read whose order the page cannot take from the key it walked.
pub(crate) fn page(
    txn: &RoTxn<'_>,
    databases: &Databases,
    matcher: &Matcher<'_>,
    terms: &[String],
    limit: usize,
) -> Result<Vec<(i64, EventId)>, StorageError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut kept = BinaryHeap::new();
    walk(txn, databases, matcher, terms, |id, created_at, rank| {
        kept.push(SearchKept {
            rank,
            id,
            created_at,
        });
        while kept.len() > limit {
            kept.pop();
        }
        Ok(())
    })?;
    Ok(kept
        .into_sorted_vec()
        .into_iter()
        .map(|kept| (kept.created_at, kept.id))
        .collect())
}

/// Walks the postings of the first query term and hands every row the matcher accepts, with its
/// rank, to `keep`.
///
/// The first term's range is the candidate list because a term's postings are one contiguous
/// range in id order, and the other terms are probed by exact key before any body is decoded.
/// The verdict is the row's own (`Matcher::matches`), so the walk narrows and the body decides.
///
/// shortcut: the walk is bounded by the first query term's postings, not by the rarest term —
/// there are no statistics to choose one; upgrade when the benchmark rig can measure a corpus
/// and a stored document frequency, or an intersection of two ranges, is worth the second index.
pub(crate) fn walk<F>(
    txn: &RoTxn<'_>,
    databases: &Databases,
    matcher: &Matcher<'_>,
    terms: &[String],
    mut keep: F,
) -> Result<(), StorageError>
where
    F: FnMut(EventId, i64, u32) -> Result<(), StorageError>,
{
    let Some((first, others)) = terms.split_first() else {
        return Ok(());
    };
    let (low, high) = term_range(first);
    let bounds = encoding::bounds(&low, &high);
    'postings: for entry in databases.events_by_term.range(txn, &bounds)? {
        let (key, _) = entry?;
        let id = posting_id(key)?;
        for other in others {
            if databases
                .events_by_term
                .get(txn, &term_key(other, &id))?
                .is_none()
            {
                continue 'postings;
            }
        }
        let Some(verdict) = matcher.matches(txn, databases, &id)? else {
            continue;
        };
        let Some(rank) = verdict.rank else {
            continue;
        };
        keep(id, verdict.header.created_at, rank)?;
    }
    Ok(())
}

/// Rebuilds the index from the rows the store holds: clear, then index in
/// [`SEARCH_REINDEX_BATCH`]-row write transactions, then the marker.
///
/// The clear is what makes the rebuild a replacement rather than an extension — an add-only pass
/// would keep every key a previous tokeniser wrote, and the body verdict would mask the stale
/// postings forever. The marker is written after the last batch, so a rebuild interrupted part
/// way leaves no valid marker and the next open runs it again.
pub(crate) fn rebuild(env: &Env, databases: &Databases) -> Result<(), StorageError> {
    let started = std::time::Instant::now();
    let path = env.path();
    tracing::info!(
        path = %path.display(),
        "the lmdb search index is being rebuilt"
    );

    let mut after: Option<Vec<u8>> = None;
    let mut indexed = 0;
    let mut keys_written = 0;
    let mut cleared = false;
    loop {
        let keys = batch_keys(env, databases, after.as_deref())?;
        if keys.is_empty() {
            break;
        }
        after = keys.last().cloned();
        let mut transaction = env.write_txn()?;
        if !cleared {
            databases.events_by_term.clear(&mut transaction)?;
            cleared = true;
        }
        let mut written = 0;
        for key in &keys {
            let id = posting_id(key)?;
            let Some(value) = databases.events.get(&transaction, id.as_bytes())? else {
                continue;
            };
            let record = rows::decode_event(value)?;
            written += index_event(&mut transaction, databases, &record)?;
        }
        transaction.commit()?;
        #[cfg(test)]
        probes::batch(path, indexed + keys.len());
        #[cfg(test)]
        probes::put_keys(path, written);
        indexed += keys.len();
        keys_written += written;
        if keys.len() < SEARCH_REINDEX_BATCH {
            break;
        }
    }

    let mut transaction = env.write_txn()?;
    if !cleared {
        databases.events_by_term.clear(&mut transaction)?;
    }
    databases.meta.put(
        &mut transaction,
        SEARCH_INDEX_MARKER,
        &[SEARCH_INDEX_VERSION],
    )?;
    transaction.commit()?;
    #[cfg(test)]
    probes::marker(path, indexed);

    tracing::info!(
        path = %path.display(),
        rows = indexed,
        keys = keys_written,
        elapsed_ms = started.elapsed().as_millis(),
        "the lmdb search index is rebuilt"
    );
    Ok(())
}

/// The next [`SEARCH_REINDEX_BATCH`] `created_at ‖ event_id` keys of the store, after `after`.
fn batch_keys(
    env: &Env,
    databases: &Databases,
    after: Option<&[u8]>,
) -> Result<Vec<Vec<u8>>, StorageError> {
    let transaction = env.read_txn()?;
    let start = match after {
        Some(after) => Bound::Excluded(after),
        None => Bound::Unbounded,
    };
    let mut keys = Vec::with_capacity(SEARCH_REINDEX_BATCH);
    for entry in databases
        .events_by_created_at
        .range(&transaction, &(start, Bound::Unbounded))?
    {
        let (key, _) = entry?;
        keys.push(key.to_vec());
        if keys.len() == SEARCH_REINDEX_BATCH {
            break;
        }
    }
    Ok(keys)
}

/// The ordered record of a rebuild's commits, for the test that reads the order back. Process
/// wide and keyed by the store's canonical path, because the rebuild runs on the blocking pool's
/// thread and a sibling test rebuilds another store.
#[cfg(test)]
pub(crate) mod probes {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{LazyLock, Mutex};

    /// One commit of a rebuild: a batch's, or the marker's.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Step {
        Batch,
        Marker,
    }

    #[derive(Debug, Default)]
    struct Records {
        events: Vec<(Step, usize)>,
        keys: usize,
    }

    static RECORDS: LazyLock<Mutex<HashMap<PathBuf, Records>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    fn with<R>(path: &Path, work: impl FnOnce(&mut Records) -> R) -> R {
        let mut records = RECORDS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        work(records.entry(path.to_path_buf()).or_default())
    }

    /// Drops what the store's path has recorded, so the next rebuild is read alone.
    pub(crate) fn reset(path: &Path) {
        with(path, |records| *records = Records::default());
    }

    /// The `(step, rows indexed so far)` list, in the order the commits happened.
    pub(crate) fn events(path: &Path) -> Vec<(Step, usize)> {
        with(path, |records| records.events.clone())
    }

    /// How many index keys the rebuilds at this path have written.
    pub(crate) fn keys(path: &Path) -> usize {
        with(path, |records| records.keys)
    }

    pub(super) fn batch(path: &Path, rows: usize) {
        with(path, |records| records.events.push((Step::Batch, rows)));
    }

    pub(super) fn marker(path: &Path, rows: usize) {
        with(path, |records| records.events.push((Step::Marker, rows)));
    }

    pub(super) fn put_keys(path: &Path, written: usize) {
        with(path, |records| records.keys += written);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    use crate::LmdbBackend;
    use crate::repositories::EventRepository;

    /// A store on a temporary directory, with the NIP-50 gate on.
    async fn backend() -> (tempfile::TempDir, LmdbBackend) {
        let directory = tempfile::tempdir().expect("tempdir");
        let backend = LmdbBackend::open(directory.path())
            .await
            .expect("the store opens");
        (directory, backend)
    }

    #[test]
    fn the_tokenizer_reduces_content_to_lowercase_alphanumeric_runs() {
        assert_eq!(terms("Bitcoin Lightning"), vec!["bitcoin", "lightning"]);
        assert_eq!(
            terms("#Bitcoin & Lightning Network"),
            vec!["bitcoin", "lightning", "network"]
        );
        assert_eq!(terms("#LightningNetwork"), vec!["lightningnetwork"]);
        assert_eq!(terms("⚡"), Vec::<String>::new());
        assert_eq!(terms("bitcoin bitcoin"), vec!["bitcoin"]);
        assert_eq!(terms("study"), vec!["study"]);
        assert_eq!(terms("studies"), vec!["studies"]);
        assert_ne!(terms("study"), terms("studies"));
        // R3's order is lowercase, then split: `İ` (U+0130) lowers to `i` plus a combining dot,
        // which is not alphanumeric, so the run ends between it and the `x`. Splitting first and
        // lowercasing each run yields the one token `i̇x`.
        assert_eq!(terms("\u{130}x"), vec!["i", "x"]);
    }

    #[test]
    fn the_rank_is_the_smallest_cover_span_then_the_event_id() {
        let query = terms("bitcoin lightning");
        assert_eq!(verdict("bitcoin lightning", &query), Some(2));
        assert_eq!(verdict("lightning bitcoin", &query), Some(2));
        assert_eq!(verdict("bitcoin x y lightning", &query), Some(4));
        assert_eq!(verdict("bitcoininveniice bitcoinisland", &query), None);
        assert_eq!(verdict("lightning", &query), None);

        // Two tokens that share their first 64 bytes are one index key and two verdicts.
        let first = format!("{}x", "c".repeat(64));
        let second = format!("{}y", "c".repeat(64));
        assert_eq!(terms(&first), vec![first.clone()]);
        assert_eq!(verdict(&second, std::slice::from_ref(&first)), None);
        assert_eq!(verdict(&first, std::slice::from_ref(&first)), Some(1));
    }

    #[tokio::test]
    async fn a_rebuild_indexes_in_batches_and_marks_last() {
        let (directory, backend) = backend().await;
        let records: Vec<EventRecord> = (0..SEARCH_REINDEX_BATCH + 1)
            .map(|index| {
                let mut event = nostream_core::Event {
                    id: EventId::from_byte_array([0; 32]),
                    pubkey: nostream_core::Pubkey::from_byte_array([0; 32]),
                    created_at: 1_700_000_000 + index as i64,
                    kind: nostream_core::Kind(1),
                    tags: Vec::new(),
                    content: format!("token{index}"),
                    sig: nostream_core::Signature::from_byte_array([0; 64]),
                };
                nostream_core::crypto::sign_event(&[3; 32], &mut event).expect("the event signs");
                EventRecord::from_event(&event)
            })
            .collect();
        backend
            .create_many(&records)
            .await
            .expect("the events store");

        let path = backend.env().path().to_path_buf();
        probes::reset(&path);
        // The C16 way: clear the index and delete the marker, so the next open rebuilds.
        {
            let env = backend.env();
            let read = env.read_txn().expect("a read transaction");
            let index = env
                .open_database::<heed::types::Bytes, heed::types::Bytes>(
                    &read,
                    Some(SEARCH_INDEX_DB),
                )
                .expect("the index opens")
                .expect("the index exists");
            let meta = env
                .open_database::<heed::types::Bytes, heed::types::Bytes>(&read, Some("meta"))
                .expect("meta opens")
                .expect("meta exists");
            drop(read);
            let mut write = env.write_txn().expect("a write transaction");
            index.clear(&mut write).expect("the index clears");
            meta.delete(&mut write, SEARCH_INDEX_MARKER)
                .expect("the marker clears");
            write.commit().expect("the commit");
        }
        drop(backend);

        let reopened = LmdbBackend::open(directory.path())
            .await
            .expect("the store reopens");
        assert_eq!(
            probes::events(&path),
            vec![
                (probes::Step::Batch, 1000),
                (probes::Step::Batch, 1001),
                (probes::Step::Marker, 1001)
            ],
            "two batch commits, then the marker carrying the whole store's row count"
        );
        assert!(
            probes::keys(&path) >= 1001,
            "the rebuild wrote a key per token: {}",
            probes::keys(&path)
        );
        {
            let env = reopened.env();
            let read = env.read_txn().expect("a read transaction");
            let meta = env
                .open_database::<heed::types::Bytes, heed::types::Bytes>(&read, Some("meta"))
                .expect("meta opens")
                .expect("meta exists");
            assert_eq!(
                meta.get(&read, SEARCH_INDEX_MARKER)
                    .expect("the marker reads"),
                Some(&[SEARCH_INDEX_VERSION][..])
            );
        }
        drop(reopened);

        probes::reset(&path);
        let reopened = LmdbBackend::open(directory.path())
            .await
            .expect("the store reopens again");
        assert_eq!(
            probes::events(&path),
            Vec::new(),
            "a valid marker skips the rebuild"
        );
        assert_eq!(probes::keys(&path), 0, "and writes no key");
        {
            let env = reopened.env();
            let read = env.read_txn().expect("a read transaction");
            let index = env
                .open_database::<heed::types::Bytes, heed::types::Bytes>(
                    &read,
                    Some(SEARCH_INDEX_DB),
                )
                .expect("the index opens")
                .expect("the index exists");
            assert_eq!(
                index.len(&read).expect("the index's length"),
                SEARCH_REINDEX_BATCH as u64 + 1,
                "the index still holds its keys"
            );
        }
    }
}
