# NIP porting ledger

One row per NIP the relay advertises, and the evidence behind the claim. This is the artifact
[`kpis.md` §1](kpis.md) names as the only one of the six KPIs that has to be built; its
reading is `ported / advertised`, and the cutover gate is 25 of 25.

## 1. The denominator

The set is `supportedNips` in `package.json:7` at the v3 grading tip `041fe34e` — the same 25
the Phase 0 audit used in [`nip-parity.md` §2](nip-parity.md). It is **not** the Rust
`SUPPORTED_NIPS` (`crates/nostream-core/src/constants.rs:17`), which carries 34, and the two
differ in both directions:

- **In the Rust list, not the v3 one (10):** `05 56 59 62 66 67 70 89 90 98` — behaviour the
  audit found implemented but unadvertised at 3.5.1 (§7 there).
- **In the v3 list, not the Rust one (1):** `15` — the audit's own verdict is that the number
  now means Marketplace, and that nostream's NIP-15 is the obsolete EOSE NIP.

Both sets are defensible and they answer different questions. The gate measures *"does the
rewrite reproduce what v3 promised"*, so it uses the v3 set. The Rust list is a decision about
what the rewrite will claim afterwards, recorded in `nip-parity.md` §10 and asserted by
`crates/nostream-core/tests/supported_nips.rs`. A row here does not move because the Rust
advertisement changed; it moves because a test appeared or disappeared.

## 2. What a row means

- **`oracle`** — the test at `041fe34e` that pins the behaviour today. TypeScript is the
  oracle for observable behaviour (`nip-parity.md` §1): a Rust module must reproduce what the
  TS suite proved, not what a `src/…` file happened to do.
- **`rust test`** — the Rust test that proves the same behaviour on `rewrite/main`.
- **`teeth`** — the inversion that makes that test fail. A test whose failure mode cannot be
  reached does not earn `ported`, however green it is; the obligation is the one `build.md`
  rows already carry.
- **`status`** — `ported` needs all three columns filled and the inversion recorded.
  `partial` is a Rust test that proves part of the behaviour. `open` is no qualifying test.

A row with an empty `teeth` cell is not `ported`, whatever the `rust test` cell says. That is
the distinction the two cheap proxies got wrong: presence is not coverage.

## 3. The ledger

Rows are ordered by NIP number. The `teeth` cell names the change that would turn the test
red, in the same shape as a `build.md` row's `inversion:`.

| nip | oracle (v3 `041fe34e`) | rust test (`rewrite/main`) | teeth | status |
|---|---|---|---|---|
| 01 | `test/unit/utils/event.spec.ts`, `test/integration/features/nip-01/nip-01.feature` | `nostream-core/tests/filter_truth_table.rs::line_1_exact_tag_value_matches` (31 probe lines); `nostream-relay/tests/handlers.rs::req_streams_a_stored_event_then_eose` | any probe line's answer flips, or the stored frame stops preceding EOSE | **partial** — `limit: 0` is asserted at the store (`parity_lmdb.rs::a_zero_limit_returns_no_rows`), not on the wire |
| 02 | `nip-02.feature` | `nostream-relay/tests/strategies.rs::contact_list_updates_the_wot_graph_with_the_p_tagged_pubkeys_when_newly_stored`, `::contact_list_upserts_the_event` | a `p` tag stops producing a follow edge, or a second kind 3 stops replacing the first | ported |
| 03 | `nip-03.feature` | `nostream-relay/tests/strategies.rs::timestamp_stores_and_broadcasts_a_valid_proof` | a kind 1040 proof is refused, stored but not broadcast, or answered without OK | ported |
| 04 | `nip-04.feature` | none specific — the generic store/serve path (`handlers.rs::req_streams_a_stored_event_then_eose`) | a kind 4 event refused or served differently from any other kind | **partial** — v3's `DEFAULT_RESTRICTED_READ_KINDS` behaviour has no test here |
| 09 | `nip-09.feature` | `nostream-relay/tests/strategies.rs::delete_soft_deletes_the_events_its_e_tags_name`, `::delete_soft_deletes_an_addressable_event_named_by_an_a_tag` | an `e`- or `a`-named target survives the kind-5, or the request itself is deleted | ported |
| 11 | `nip-11.feature` | none — nothing serves an HTTP document; `supported_nips.rs` asserts the constant only | a served NIP-11 document omits an advertised id or a `limitation` key | **open** — no HTTP surface yet (decision D1, `nip-parity.md` §10) |
| 12 | `test/unit/schemas/filter-schema.spec.ts`, `test/unit/utils/event.spec.ts` | `nostream-core/tests/filter_truth_table.rs` (the single-letter tag lines) | a `#e` or `#p` line's match flips | ported |
| 13 | `nip-13.feature` | `nostream-relay/tests/handlers.rs::the_static_proof_of_work_requirements_are_enforced` | an event under the leading-zero-bit floor is accepted | **partial** — the `nonce`/`difficulty` tag is never exercised |
| 14 | `test/unit/schemas/event-schema.spec.ts` (`accepts subject tag on text note events`) | `nostream-relay/tests/nip_vectors.rs::nip14_a_kind_1_event_returns_its_subject_tag` | the `subject` tag is dropped or rewritten across store and serve | ported |
| 15 | tombstone — EOSE is the `nip-01.feature` row | `nostream-relay/tests/handlers.rs::req_streams_a_stored_event_then_eose` | EOSE is omitted, or sent before the stored events | ported |
| 16 | `nip-16.feature` | `nostream-relay/tests/strategies.rs::replaceable_upserts_the_event`, `::ephemeral_sends_ok_and_broadcasts_without_storing` | a replaced event is kept, or an ephemeral one is stored | ported |
| 17 | `nip-17.feature` | `nostream-relay/tests/strategies.rs::gift_wrap_stores_a_valid_wrap`; `handlers.rs::inner_kinds_must_be_gift_wrapped` | a kind 1059 wrap is refused, or a bare 13/14/15/444 is accepted | ported |
| 20 | `test/unit/handlers/event-message-handler.spec.ts` (the OK assertions) | `nostream-relay/tests/handlers.rs::the_default_strategy_answers_ok_and_duplicate`, `::a_restricted_only_req_from_an_unauthenticated_client_is_closed` | a duplicate is accepted twice, or CLOSED loses its machine-readable prefix | ported |
| 22 | `nip-22.feature` | `nostream-relay/tests/nip_vectors.rs::nip22_a_kind_1111_comment_is_stored_and_served_unchanged` | a comment's `K`/`E`/`P`/`k`/`e`/`p` tags are dropped or reordered on re-serve | ported — the code implements Comment, not the retired `created_at` limits |
| 25 | `nip-25.feature` | `nostream-core/tests/wire_codec.rs::strict_event_schema_checks_the_refinements` | a kind 7 with no `e`/`a` target is accepted | **partial** — content `+`/`-`/emoji is never asserted, and no reaction is stored or served |
| 28 | `nip-28.feature` | `nostream-relay/tests/nip_vectors.rs::nip28_channel_metadata_is_replaceable_and_channel_events_are_not` | kind 41 stops replacing, or kind 42 starts replacing | **partial** — kinds 43–49 are not exercised |
| 33 | `nip-33.feature` | `nostream-relay/tests/strategies.rs::parameterized_replaceable_uses_the_first_d_tag_value`; `nip_vectors.rs::nip89_recommendation_and_handler_events_are_stored_and_served` | the dedup key becomes a later `d` value, or the older `d`-twin is served | ported |
| 40 | `nip-40.feature` | `nostream-relay/tests/handlers.rs::an_expired_event_is_rejected`; `connection.rs::an_event_expired_when_the_read_starts_is_not_delivered` | an expired event is stored, or served by a read that started after expiry | ported |
| 42 | `test/unit/adapters/web-socket-adapter.spec.ts`, `event-message-handler.spec.ts` | `nostream-relay/tests/handlers.rs::auth_outcomes_are_the_captures_seven`, `::a_restricted_read_delivers_only_to_the_author_or_a_p_tagged_reader` | one of the seven AUTH rejections becomes an accept, or a restricted REQ is served unauthenticated | ported |
| 43 | `test/unit/handlers/event-message-handler.spec.ts`, `event-strategies/invite-request-event-strategy.spec.ts`, `leave-request-event-strategy.spec.ts` | `nostream-relay/tests/handlers.rs::an_invite_request_mints_one_kind_28935_event_before_eose`; `strategies.rs::the_join_request_admits_and_answers_with_the_welcome` | the invite is minted twice, minted for an unauthenticated socket, or a join is admitted without spending the code | **partial** — no kind 13534 membership list and no relay-signed membership event |
| 44 | `test/unit/utils/nip44.spec.ts` | `nostream-core/tests/nip44_parity.rs::produces_the_canonical_payload_from_the_nip44_spec_test_vector`, `::decrypts_the_canonical_nip44_spec_test_vector` | one byte of the canonical v2 payload changes, in either direction | ported |
| 45 | `nip-45.feature`, `test/unit/handlers/count-message-handler.spec.ts` | `nostream-relay/tests/handlers.rs::count_answers_with_the_count_object` | the `COUNT` reply shape changes, or a disabled COUNT is still answered | **partial** — every COUNT test counts an empty store; no non-empty match set is counted |
| 50 | `nip-50.feature` | `nostream-relay/tests/nip_vectors.rs::nip50_a_search_filter_is_served_only_when_enabled` | a search filter is accepted with the setting off, or returns non-matching events | **partial** — rank ordering is not asserted anywhere |
| 65 | `nip-65.feature` | `nostream-relay/tests/nip_vectors.rs::nip65_a_relay_list_is_stored_and_replaces_the_previous_one` | a second kind 10002 stops replacing the first | ported |
| 77 | `test/unit/handlers/neg-open-message-handler.spec.ts` | none — the relay answers `NEG-OPEN` with `["NOTICE","invalid: Invalid input"]` (`handlers.rs::an_invalid_frame_gets_the_capture_notice`) and both encoders return `NotImplemented` | negentropy sync never happens, which is today's whole surface | **open** — `negentropy_parity.rs` asserts library frames, never relay sync |

## 4. Counting

`ported` counts cells, not intentions: the number in `kpis.md` §1 is the count of rows whose
status reads `ported`, out of 25. Nothing else is aggregated — a percentage over `partial` rows
would mix a missing branch with a missing feature.

**Measured on `rewrite/main` at `f01cb5f3`: 15 of 25 `ported`, 8 `partial`, 2 `open`.** Every
Rust citation above was checked to exist at that commit, and the two `open` rows were read in
the code rather than inferred from a missing file.

| status | nips |
|---|---|
| ported | `02 03 09 12 14 15 16 17 20 22 33 40 42 44 65` |
| partial | `01 04 13 25 28 43 45 50` |
| open | `11 77` |

## 5. What the missing ten cost

The gap is not uniform, and the fix differs per row, which is why the ledger lists them
instead of a percentage:

- **Two are unbuilt surfaces, not untested code.** NIP-11 needs an HTTP document served at the
  relay's own URI (decision D1 defers it), and NIP-77 needs negentropy on the wire — the relay
  answers `NEG-OPEN` as an invalid frame today. Neither moves until someone builds it, and
  neither can be closed by a test.
- **Eight are branches a test was never written for**, each named in its row: `limit: 0` on the
  wire (01), the restricted-read default (04), the `nonce`/`difficulty` tag (13), reaction
  content and store/serve (25), kinds 43–49 (28), a non-empty `COUNT` (45), rank ordering (50),
  and the kind 13534 membership list (43).
- **One is a counting artefact worth naming.** NIP-15 is a tombstone whose behaviour is EOSE,
  so its row cites the base-protocol test; that is not double-counting NIP-01, because the two
  rows ask different questions of the same assertion.

Closing the eight partials is test work, not port work: the behaviour exists and a test for it
does not. That distinction is the reason the status column has three values rather than two.
