# ADR 0012: NIP-50 search over the embedded store — a term index, a tokeniser and a rank (job 028)

- **Status:** accepted (job 028, Phase 2)
- **Deciders:** the rewrite team, on the operator's decision of 2026-11-11 and the evidence in job 028's recon and spec
- **Date:** 2026-11-11

## Context

ADR 0011 records the LMDB event store and leaves one read unanswered there: a filter carrying
`Filter::search` reached `admits` and came back `NotImplemented { module:
"storage::lmdb::nip50_search" }` on all three read paths. The capture answers the field on Postgres
with `to_tsvector @@ plainto_tsquery` and orders by `ts_rank`; its in-memory matcher applies a
lowercase substring rule instead, and the repository records that the two rules contain neither the
other (`repositories.rs`, `SearchRule`). The fixture's entry 21 is the Postgres answer over the
crate's own 483-event corpus — four rows, in `ts_rank` order — and the parity arm replays it now.

This record is its own number rather than a section of 0011 because the change is to the store's
format and its open cost, not to the shape of a query: a named database is added, a key shape is
fixed, a marker joins `meta`, and `LmdbBackend::open` gains a step that a store written before the
index pays once. Those are the parts a later reader judges by the on-disk contract, and the next one
is that reader's to reopen.

## D1 — A thirtieth named database, `events_by_term`, keyed `term ‖ event_id`

`Databases` gains one field and `Databases::create` one line
(`crates/nostream-storage/src/lmdb/mod.rs:140`, `:185`), so the environment holds 30 named databases
under `LMDB_MAX_DBS = 64` (`:53`). The key is one token of the event's `content` — truncated to 64
bytes on a `char` boundary (D2) — followed by the row's 32-byte id, and the value is empty, as every
other index database's is (`crates/nostream-storage/src/lmdb/search.rs:64-94`). A term's postings
are therefore one contiguous byte range in id order, seekable as `term .. term ‖ 0xff×32`, and the
order the range is walked in is stable.

The index is maintained by `write_event` and `hard_delete` (`lmdb/events.rs:248`, `:298`), the only
two functions that add or remove an `events` row, so `create`, `upsert`/`upsert_many` (which
hard-deletes the superseded row and writes the new one in one transaction) and
`delete_expired_and_retained` all reach it; a soft delete rewrites the value and leaves the terms,
because the content did not change. It is maintained **whether or not the NIP-50 gate is on**: the
gate is a read gate, so a store written with the feature off answers a search the moment it is
turned on, with no rebuild.

**Alternatives rejected.**

- **A scan-time token filter, no index and no rank.** This is the real alternative and it was built:
  design A, commit `6b50424` on branch `factory/028a-nip50-scan`, ~96 added production lines across
  `lmdb/events.rs`, `lmdb/mod.rs` and `repositories.rs` (the `SearchRule::TokenTerms` variant). It
  answered the right *set* — the token rule selects exactly entry 21's four rows — and paid for it
  in three ways. It had no rank, so its order was the store's page order (`created_at`), and the
  fixture's recorded order could only be reproduced by re-sorting the capture's rows **inside the
  test**; a limited search and a limited count therefore disagreed with Postgres on the branch's
  set. Every candidate the plan offered cost a body decode, so a term carried by a handful of rows
  walked `events_by_created_at` to the page bound, and a searched count walked its ranges whole. And
  it could not grow into the rank without keeping that cost, because the scan has no posting to
  narrow the candidate set with.
- **The core matcher's substring rule** (`Filter::matches`) was rejected on measurement: over the
  same corpus it selects a fifth row, `f8ef9793…`, whose content carries `bitcoininveniice`,
  `bitcoinisland` and `#LightningNetwork`. A backend that applied it could not pass the fixture.

**Consequence.** Every event write now pays one `put` per distinct token of its content, and the
index holds one key per (term, row) — the 20 000-row measurement in D6 wrote 12 keys per row for a
12-token body. That is the write cost the read path buys back.

**What would overturn it:** a benchmark showing the write amplification unacceptable on this
branch's own corpus, or a need for the index to carry tag keys as well (which changes the key shape
and makes the key, not the body, authoritative). Either is a store-format change with its own
record.

## D2 — One hand-rolled tokeniser, `search::terms`

Unicode lowercase of the whole text, **then** maximal runs of `char::is_alphanumeric()`, duplicates
dropped (`lmdb/search.rs:108-144`). The order is part of the rule, not an implementation detail: a
case mapping can turn one character into several, and `İ` (U+0130) lowers to `i` plus a combining
dot, which is not alphanumeric — so `İx` is the two tokens `i` and `x` here, and one token if the
runs were taken from the original text and each run lowered afterwards. It is what the write path
indexes, what the read path resolves queries with and what the verdict compares, so the index and
the predicate cannot disagree about a token.
**What that changes for real content.** A body containing a dotted `İ` (Turkish `İstanbul`, say)
now indexes as the two keys `i` and `stanbul` where the split-then-lower order produced the single
key `i`+U+0307+`stanbul` — one term became two, so a query for `stanbul` starts matching a body it
did not match before, and the store that indexed the old way answers differently until it rebuilds
(D5). No existing criterion observes this: the fixture's corpus has no such character, and every
test of the rule would pass under either order were it not pinned explicitly.

Against Postgres' `simple` configuration it reproduces the no-stemmer, no-stop-list part — `the` is
an ordinary token and `study` does not match `studies` — and it loses the parser's classes (URLs,
e-mails, hosts) and any CJK segmentation. **On the fixture's 483-event corpus the two select the
same four rows, and no claim beyond that is made.**

No dependency is added: no crate reproduces Postgres' parser, and this environment cannot verify one
against Postgres. A token is cut to `SEARCH_TERM_MAX_LEN = 64` bytes on a `char` boundary for the
key, which can only merge two keys, never split one: a shortened key *proposes* a candidate and the
body decides (D3).

**Alternatives rejected:** an analyser crate such as `tantivy` — a second dependency and a rule this
environment cannot check against the configuration it claims to reproduce; and Postgres' parser
classes reproduced by hand — a parser is not a tokeniser, and hand-writing one buys a rule no test
here can compare.

**What would overturn it:** a corpus or a deployment that needs stemming, a second language
configuration, or CJK segmentation. Then the tokeniser becomes a real analyser, the index's contents
change with it, and `SEARCH_INDEX_VERSION` (D5) is what makes every existing store rebuild.

## D3 — The index narrows candidates and the body decides

A row matches a search when every distinct query term is one of the tokens of its `content` — never
of a tag (`lmdb/search.rs:177-215`). The walk takes the postings of the first distinct query term,
probes each other term's exact key for the same id before decoding anything, and then asks
`Matcher::matches`, whose one body decode answers both the tag families and the search verdict
(`lmdb/search.rs:327-363`). A stale or truncated posting therefore cannot produce a false positive,
and completeness is the write path's (D1). A query whose tokens are empty — a punctuation-only
query, which `plainto_tsquery` turns into an empty tsquery — selects nothing and takes no walk.

**Alternatives rejected:** making the index authoritative (a stored verdict per key) would remove
the body decode and would make every stale posting a wrong answer — the failure mode the truncation
in D2 exists to keep harmless.

**What would overturn it:** an index exact enough to decide alone, which means no truncation, no
tokeniser change without a rebuild, and a key that carries the tag criteria too. That is D1's
trigger, not a separate decision.

## D4 — The rank is the smallest cover span, and a tie breaks by `event_id`

For a body that holds every term, the rank is the smallest window of consecutive tokens covering all
of them; the page is ordered by rank ascending, then `event_id` ascending, and keeps its own heap
because that order is not the index's key order (`lmdb/search.rs:171-215`, `:251-315`).

**The fixture recorded `ts_rank`'s order and this differs.** It reproduces that order on this corpus
— spans 2, 2, 2, 4 for the four rows — which is **not** a claim of `ts_rank` parity: `ts_rank` also
weights term frequency and document length, the four recorded rows tie on frequency, and no Postgres
is reachable here to compare values. Two consequences follow, and both are deliberate:

- a `limit` no longer truncates by `created_at` for a searched read: **on a limited search LMDB
  ranks by (span, id) where Postgres keeps `created_at DESC`**;
- a limited count counts that rank page, where Postgres' limited branch counts its created-at
  branch. The two agree on such a branch's size and can disagree on its set, which only a count over
  more than one filter can see. `branch` is the one router, so the rows a limited count counts are
  the rows the read returns.

**Alternatives rejected.** A **frequency rank** reproduces neither: the four recorded rows tie on
term frequency, and a frequency order sorts them `5454369c…`, `9ae1fef4…`, `c004…`, `cb41289d…`,
which is not the recorded sequence. A **`ts_rank` clone** is rejected because its weights and its
document-length normalisation are Postgres' to define and this environment cannot measure them; a
rank that cannot be checked is a guess in a decision record. Ordering by `created_at` (design A) is
rejected because the fixture's order is not time order — that was the measurement that separated the
two designs.

**What would overturn it:** a Postgres-compatible ranker landing — one that computes `ts_rank`'s
values and is verified against a live Postgres. The index does not have to carry term positions for
it (the body is decoded for the verdict), but the page's order and the limited count would both
become `ts_rank`'s, and the divergence above goes with a contract change, not a tweak.

## D5 — `meta` carries `search-index-version`, and "stale" means absent or different

`meta` holds `SEARCH_INDEX_MARKER = b"search-index-version"` whose one-byte value is
`SEARCH_INDEX_VERSION = 1` (`lmdb/search.rs:34-39`). `LmdbBackend::open` reads it in the transaction
that creates the databases (`lmdb/mod.rs:221-232`); when it matches, nothing else happens.

**Stale** is the marker being absent — a store written by a binary that had no index — or holding
another byte — an index a previous tokeniser built. Both are replaced, not extended: `events_by_term`
is cleared in the rebuild's first write transaction, before that transaction writes a key. An
add-only rebuild would keep every key an older tokeniser wrote, so the index would be the union of
two rules forever, and no answer would show it, because the body verdict masks a stale posting. The
clear is what makes "rebuilt" mean **replaced**.

The marker is written **last**, after the final batch commits. A rebuild killed after the clear
leaves keys missing and no valid marker, so the next open clears and rebuilds again; a marker written
first would let a half-built index answer a search. The probe tests read the marker after `open` and
before any search, which is what pins the ordering rather than the intent.

**Alternatives rejected:** a per-row format byte inside the index value — the value is empty, and a
byte per posting would be paid on every key to answer a question one key answers once. A silent
add-only backfill is rejected above.

**What would overturn it:** an incremental rebuild that knows which rows an older tokeniser indexed
differently. The clear would become a delta, and the marker would have to record more than one byte
— a new version, not an edit to this one.

## D6 — The rebuild runs on open, in batches of 1000, and its cost is paid once

`LmdbBackend::open` rebuilds when D5 says stale: it walks `events_by_created_at`, indexes
`SEARCH_REINDEX_BATCH = 1000` rows per write transaction (`lmdb/search.rs:50`, `:372-437`), and logs
one line before and one after, with the row count, the key count and the elapsed milliseconds, so a
slow first open is visible rather than mysterious. A fresh store writes the marker and indexes
nothing.

**The open cost, measured.** A rebuild on this host indexes 20 000 rows of a 12-token prose body —
240 000 postings — in **1.37 s in the release profile** (14 600 rows/s) and 2.21 s in a debug build
(9 000 rows/s): the order of a second per 20 000 rows, about 7 s per 100 000 and about 70 s per
million on this machine. It is the open cost a store written before the index existed adds, **once**:
the marker makes the second open a read of one key, and a store written by this binary maintains the
index as it writes (D1), so it never rebuilds.

**It blocks inside `open`, not in the background.** The rebuild runs on the caller's `open` (on a
blocking-pool thread that `open` awaits), so the first open after an upgrade returns late by that
duration rather than starting a daemon that answers searches eventually: a store of 20 000 events
opens about 1.4 s late, 100 000 about 7 s, a million about 70 s on this host. For any store where
that delay is unacceptable on a restart, the answer is an incremental or offline rebuild (below) and
not a background build that answers from a half-built index — the number is here so that decision is
taken in advance rather than discovered during one.

**Alternatives rejected:** a background build after `open` returns — the store would answer searches
from a half-built index, which is the state D5's ordering exists to prevent. A per-row lazy build on
first search — the same defect, with the first search paying for it invisibly.

**What would overturn it:** a production corpus where minutes on the first open is unacceptable to
operators. The answer then is either a background build with an explicit "search unavailable until
built" state, or a migration path (`#864`'s `pg-to-lmdb` slice) that builds the index as it inserts.

## D7 — Gate off, blank, and tokenless queries follow Postgres

With the NIP-50 gate off, or a `search` that trims to empty, every read behaves exactly as it does
without the field: this is `is_search`'s own rule (`postgres/sql.rs`), and it matters because the
COUNT handler forwards `search` to a backend with the gate off. A query whose every character is
punctuation is a search that selects nothing, not a blank one.

The core matcher disagrees on the whitespace-only case (`Filter::matches` matches nothing for
`"   "`); the spec follows Postgres, because the two backends' agreement is the property under test,
and this paragraph is where a reader meets that as a choice rather than a defect.

**What would overturn it:** Postgres changing its rule, or a decision that the two backends may
answer a blank search differently. Neither is reachable from this tree.

## D8 — Only `simple` is answered, and the declaration says so

The LMDB gates carry the NIP-50 query length and whether `nip50.language` is the `simple`
configuration the index reproduces. When a search is answered under any other language the read
returns `InvalidArgument` naming `simple`, from `find_by_filters`, `count_by_filters` and
`find_reconciliation_items` alike; answering with simple-token semantics under `english` would be a
silent divergence from a stemmed Postgres predicate, which is the defect class this job removes.
`LmdbBackend::search_rule` declares `SearchRule::ToTsvector { language: "simple" }` when the gate is
on and `SubstringTerms` when it is off (`lmdb/mod.rs:416-425`), matching Postgres' shape, so the
relay withholds a `finish` hint over a searched read instead of claiming a completeness the
enumeration cannot establish.

**Alternatives rejected:** a `SearchRule::TokenTerms` variant, which design A added to publish its
own rule. This store reproduces a Postgres rule instead of declaring a private one, and the variant
is not on this branch.

**What would overturn it:** an index that reproduces a second configuration — stemmed `english`
first. The tokeniser becomes an analyser (D2), the marker's version moves (D5), and `search_rule`
has one more true answer.

## D9 — The rebuild is serialised per store path, within a process

Two `LmdbBackend::open` calls on one store, run at the same time, used to rebuild the index twice,
and the second rebuild is the dangerous one: the first writes the marker after its last batch, so a
caller that starts while that first rebuild is still committing batches clears an index the first is
filling and then writes a marker over a partly refilled one. The marker is the whole of D5's state,
so any open inside that window would skip the rebuild and serve an incomplete index with no error
anywhere. **Measured** at `a21b622`, with a store of 1 500 rows whose index and marker were cleared,
two concurrent opens recorded
`[(Batch,1000),(Batch,1000),(Batch,1500),(Batch,1500),(Marker,1500),(Marker,1500)]` — four batches
and two markers where one rebuild writes two and one.

`open` therefore holds one `std::sync::Mutex` per store path across the marker read, its comparison
and the whole rebuild (`lmdb/mod.rs`, `INDEX_REBUILDS`), and releases it before the usage read. It is
per path rather than one process-wide lock, because a single lock would hold one store's cold start
against every other store's open and buy nothing; it is a `std::sync::Mutex` taken inside the
`spawn_blocking` closure, so nothing holds it across an `await`; and nothing else in the crate takes
it, so there is no ordering to get wrong. An entry is kept after use because the map is bounded by
the number of distinct store paths a process opens, which is the number of stores it owns.

**Within a process is the whole of the contract**, and the protection one would assume is not there:
heed's process-wide `OPENED_ENV` cache keys an environment by canonical path and hands a second open
of the same directory the same `Env` (`heed-0.20.5/src/env.rs:40`, `:254-262`), so LMDB's
one-environment-per-path rule never sees the second caller and nothing below this decision
arbitrates the two.

**A second process opening the same directory is outside this contract.** LMDB serialises write
transactions between processes but not this read-modify-write: two processes can each read an absent
marker and each rebuild. One process owns one environment, which is the deployment shape this store
has, and fencing a second one needs a protocol the store does not carry.

**The rejected sentinel.** The design that would cover a second process is an `IN_PROGRESS` value
written to `search-index-version` by the rebuild's first write transaction — the one that clears the
index — and compared-and-set at the end, so a reader that finds `IN_PROGRESS` waits or refuses
instead of rebuilding. It is rejected because it needs a crash-recovery rule the store does not
have: a process killed mid-rebuild leaves `IN_PROGRESS` behind, and telling a dead writer from a
live one takes a lease with a timestamp and a boot identity, which is a second decision with its own
failure modes. With no second writer to justify it, the lock is the whole answer.

**What would overturn it:** more than one process opening one store — a sidecar, a CLI against a
live store, or a relay started twice on one volume. The sentinel above, or a directory lock the
operating system drops when its holder dies, then stops being optional.

## Consequences

- One more named database, its key shape and its marker are maintained by hand; the environment
  stays inside `LMDB_MAX_DBS = 64` with room.
- A searched read is a range over one term's postings, and its page is bounded by the same
  `MAX_PAGE_KEYS` as every other page; a row is decoded only when every query term's posting is
  present.
- A searched read's order is `(span, event_id)`, and a limited searched count counts that page.
  Postgres orders a limited search by `created_at DESC`; the two agree on the set of the unlimited
  form and can differ on a limited branch's set.
- Every event write pays a `put` per distinct token; a store written before the index pays one
  open-time rebuild of about a second per 20 000 rows (measured above), once.
- The capture's `ts_rank` values are still recorded only as an order in the fixture. No arm here
  proves the two rank *numbers* agree, and none claims it.
- Two opens of one store serialise on a lock per store path, so a store's index is rebuilt once
  however many callers open it at the same time; a second **process** on one store is unsupported
  and would need D9's rejected sentinel.

## How this record was reviewed, and what was lost

The spec this record implements was attacked twice by an adversarial pass before any code was
written. **The second pass's report was destroyed**, and this note exists so the loss is visible
where the obligations live rather than only in a conversation: a later job was written against the
same file name in the same folder and overwrote it, and the first pass survives only because it
had been renamed.

**Pass one** (18 criteria red at base, 4 green, 0 undecidable) found nine holes: a criterion whose
literal wording broke a correct build, `C7` checking answers instead of the index, `C16` never
asserting population *before* the first search, `C17` unable to distinguish a marker written first,
`C4` pinning two of seven filter combinations, unpinned test commands that pass when they match no
test, two database names, long-token truncation, and an unresolved `Matcher` seam.

**Pass two** (20 red, 2 green, 0 undecidable) found the class that matters most here — implementations
that are *nearly* right and fail nothing: a rebuild that adds keys without clearing (this record's
D6 needs the clear-before-write, and the spec's stale-key criterion is what forced it); a router
placed in `page` only, which a limited count bypasses; a language refusal implemented on the find
path and not the count path; plus the rank heap's **polarity** (a `Reverse` min-heap evicts the
best row when it caps, so D4's order needed the opposite type), `C5`'s arithmetic (three span-2
rows, not two), and `heed`'s real `open_database` arity, which the criteria had written wrong.

Every finding from both passes is folded into the spec the build was written against; what is lost
is the report, not the requirements. The lesson is recorded here rather than in a process note
because it is a record-keeping obligation of this sequence: **an adversarial report is an artifact
of the decision, so it is written to a path that names its subject and its pass**, not to a shared
`spec-redteam.md` that the next design will overwrite.

## What would overturn this record

Any one of: a verified Postgres-compatible ranker (D4), an index that must carry tag keys or decide
alone (D1, D3), a tokeniser that has to stem or segment another script (D2), an incremental rebuild
(D5, D6), an operator corpus where the open-time rebuild is unacceptable (D6), or a second process
opening one store (D9). Each is a store format, open-cost or concurrency-contract change, and each
belongs to a new record in this sequence.
