//! Parity with `test/unit/utils/negentropy.spec.ts` (44 mocha cases, measured green at the
//! capture commit `242a3001`), against the `negentropy` crate 0.5.2 that `negentropy.rs`
//! is a seam over.
//!
//! | mocha block | cases | here |
//! |---|---|---|
//! | `NegentropyStorageVector` | 14 | 10 expressible + 4 recorded divergences |
//! | `wire compatibility with the reference implementation` | 3 | 3 |
//! | `reconciliation` | 15 | 14 expressible + 1 recorded divergence |
//! | `malformed input` | 12 | 10 expressible + 2 recorded divergences |
//!
//! ## The cases the crate answers differently
//!
//! Spec D8 names six; each has a test here that records the behaviour replacing it. The
//! seventh was found while writing this module and is recorded the same way.
//!
//! 1. `rejects duplicate items when sealing` — the crate's `seal()` de-duplicates silently
//!    (`storage.rs:111-112`), so the test asserts one item after seal, not an error.
//! 2. `hands out frozen items so callbacks cannot reorder a sealed set` — `Item` is `Copy`
//!    and handed to the callback by value; a callback cannot reach the set.
//! 3. `is not affected by the caller changing an id buffer after inserting it` — `Id` is
//!    `[u8; 32]` by value; there is no shared buffer to change.
//! 4. `rejects range indexes that are negative, fractional or not finite` — the parameters
//!    are `usize`; only `begin > end || end > len` (`Error::BadRange`) is expressible, which
//!    the out-of-range case already covers.
//! 5. `rejects varints that never terminate` — the crate's `decode_var_int`
//!    (`encoding.rs:16-27`) has no length bound, so ten continuation bytes decode as zero.
//! 6. `rejects varints beyond the safe integer range` — the same decoder accumulates into
//!    `u64` without a safe-integer check.
//! 7. **`restarts a frame-truncated reply at the last written bound, not after the dropped
//!    range`** — not in D8's table. The capture's port tracks `writtenUpTo`
//!    (`src/utils/negentropy.ts:313-317`) and answers `fingerprint(120, 160)`; the crate
//!    passes the *current range's* `upper` to the trailing fingerprint
//!    (`lib.rs`, `reconcile_aux`), so it answers `fingerprint(160, 160)`. The trailing
//!    fingerprint is the input to the peer's next comparison, so the range is re-offered and
//!    the session can still converge; what is pinned here is the *difference* in that
//!    fingerprint, and what is pinned next door
//!    (`still_converges_when_several_mismatched_ranges_are_cut_by_the_frame_limit`) is a
//!    different frame shape converging under the same limit. No test drives this exact
//!    message to convergence. `src/utils/negentropy.ts`'s own comment says why the capture
//!    changed this; recorded in ADR 0002 and build.md as a revisit trigger.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use nostream_core::event::EventId;
use nostream_core::negentropy::{
    Bound, Negentropy, NegentropyError, NegentropyId, NegentropyStorageBase,
    NegentropyStorageVector, PROTOCOL_VERSION, storage_from_items,
};
use sha2::{Digest, Sha256};

const BASE_TIMESTAMP: i64 = 1_700_000_000;

/// `Generated with hoytech/negentropy js/Negentropy.js`: client holds items 0-39
/// (`negentropy.spec.ts:240-241`).
const REFERENCE_FIRST_MESSAGE: &str = concat!(
    "6186aacfe20101c4019519545952534ac1dbf6efee31f306a50201bf010e45e53bc3ac3b96527fcd6c09d2047802017101744f77934468e967eeeabc0f798d8ef4020001873c27d9520afdf1a90c94fc3418b485010165011eb5a27d5fd29d201a8804d82fe10c2e02018e013ee24cc071884f88d81e56c138672c4402015801ce08fb40009f4496c99e002ce58159b402000166784dbdc5e2e720329752a4d7",
    "fe1fdc0101ca01e53cc691284a4fa5d32d61bf920bd03f020001392bfa2b9c1ea6c1e44575ee2cd47a9f0101cd01161b325b1e6b1f8c0e5e6dcce95c673a020001db0d53fffe5622719353467e5a4064340101a101f1c06ede4cff82a242fda6253d18a06f020001d5785181bb433c6f0d3ff48de323251a01019c01a054d5da1b42babccc1272c167eb56db0000015dfae5a6e074b6e1d2014f2b9134c08f",
);

/// Server holds items 10-49 (`negentropy.spec.ts:242-243`).
const REFERENCE_RESPONSE: &str = concat!(
    "6186aacfe20101c402000201bf02000201710200020002029103607c71902fd449f5737b2dda7c5a4ee31e0cf1fb7cf13f2f951d3b131c169266fae12bbe176c85e6cc8940ff97afc4b7f899f13192cbd756856aaa06261f07019c000000020c9c185f5a0cb59b837e6ffc631a537507a7eefede982d9663577ae545fab5b287d0f8bae1791c4ccb49a9c267107c73043df98a26bc696febebd84c864beb6816",
    "0f39aca329fab189af2e828cd50a518ac803854a3ae5c280b1e3873cdefc268e609a8d39e4370faed4290168ca6c9a7237f0e29923b0e48b45eb5ae6851bca6f8120620c1dfeb40c48a28f4e2dfe67c3f0cf490d80602e30a383700fb85cedf68d7f261ad6c9ff45c56880496fb12b1a1209c701ad76fbca9684a3490e1467a0689fb4d021cd5fa4ba91eda8283b7daddccd70fe41e26e6a502c17de020038ba",
    "6e665739195287c00becd4b248675c994d7c10f4b5a12c524b9b62e308740e31e05b1a766d5ba1ebf8ba17bee7da0164907525d095b6f18fbc3dd5b8197c1e11e56cdae96afbdba7c20dab5ddf6d34daa1847b809f79ada60945b8305d51448a6c8109848821eae5957bf56c1c8ca51b10d06cbbfda2ebcdbc8f5163a2cf6d5ddc25b6dde85fbcdb2e25ee0ec80c7815bf9784c8a710c66536a094bff846333d",
);

fn event_id(label: &str) -> EventId {
    let digest = Sha256::digest(label.as_bytes());

    let mut id = [0u8; 32];
    id.copy_from_slice(&digest);

    EventId::from_byte_array(id)
}

fn entries(from: usize, to: usize) -> Vec<(i64, EventId)> {
    entries_with(from, to, 4)
}

fn entries_with(from: usize, to: usize, per_timestamp: usize) -> Vec<(i64, EventId)> {
    (from..to)
        .map(|index| {
            (
                BASE_TIMESTAMP + (index / per_timestamp) as i64,
                event_id(&format!("negentropy-test-{index}")),
            )
        })
        .collect()
}

fn storage(entries: &[(i64, EventId)]) -> NegentropyStorageVector {
    storage_from_items(entries.iter().copied()).unwrap()
}

fn negentropy_id(event_id: &EventId) -> NegentropyId {
    NegentropyId::from_byte_array(*event_id.as_bytes())
}

fn ids_of(entries: &[(i64, EventId)]) -> Vec<NegentropyId> {
    entries
        .iter()
        .map(|(_, id)| negentropy_id(id))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn difference(left: &[(i64, EventId)], right: &[(i64, EventId)]) -> Vec<NegentropyId> {
    let right_ids: BTreeSet<NegentropyId> = right.iter().map(|(_, id)| negentropy_id(id)).collect();

    ids_of(left)
        .into_iter()
        .filter(|id| !right_ids.contains(id))
        .collect()
}

fn fingerprint(storage: &NegentropyStorageVector, begin: usize, end: usize) -> [u8; 16] {
    storage.fingerprint(begin, end).unwrap().to_bytes()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|index| u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).unwrap())
        .collect()
}

fn varint(mut value: u64) -> Vec<u8> {
    let mut groups = Vec::new();

    while value > 0 {
        groups.push((value % 128) as u8);
        value /= 128;
    }

    if groups.is_empty() {
        groups.push(0);
    }

    groups.reverse();

    let last = groups.len() - 1;

    groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| if index < last { group | 128 } else { group })
        .collect()
}

struct Outcome {
    rounds: usize,
    have: BTreeSet<NegentropyId>,
    need: BTreeSet<NegentropyId>,
}

/// The capture's `sync()` (`negentropy.spec.ts:63-85`): the client initiates, the server
/// only answers, until the client has nothing left to say.
fn sync(
    client: &[(i64, EventId)],
    server: &[(i64, EventId)],
    server_frame_size_limit: u64,
) -> Outcome {
    let mut initiator = Negentropy::owned(storage(client), 0).unwrap();
    let mut responder = Negentropy::owned(storage(server), server_frame_size_limit).unwrap();

    let mut have = BTreeSet::new();
    let mut need = BTreeSet::new();
    let mut message = Some(initiator.initiate().unwrap());
    let mut rounds = 0;

    while let Some(current) = message {
        rounds += 1;
        assert!(rounds < 50, "session did not converge");

        let reply = responder.reconcile(&current).unwrap();
        let mut have_ids = Vec::new();
        let mut need_ids = Vec::new();

        message = initiator
            .reconcile_with_ids(&reply, &mut have_ids, &mut need_ids)
            .unwrap();

        have.extend(have_ids);
        need.extend(need_ids);
    }

    Outcome { rounds, have, need }
}

fn responder() -> Negentropy<'static, NegentropyStorageVector> {
    Negentropy::owned(storage(&entries(0, 100)), 0).unwrap()
}

// --- NegentropyStorageVector (10 expressible) --------------------------------------------

#[test]
fn rejects_ids_that_are_not_32_bytes() {
    assert_eq!(
        NegentropyId::from_slice(&[0u8; 31]),
        Err(NegentropyError::InvalidIdSize)
    );
    assert!(NegentropyId::from_slice(&[0u8; 32]).is_ok());
}

#[test]
fn rejects_timestamps_that_are_negative_fractional_or_the_infinity_sentinel() {
    assert!(storage_from_items([(-1, event_id("a"))]).is_err());
    assert!(storage_from_items([(i64::MAX, event_id("a"))]).is_err());
    // Fractional timestamps are not representable: the argument is `i64`.
    assert!(storage_from_items([(BASE_TIMESTAMP, event_id("a"))]).is_ok());
}

#[test]
fn refuses_to_insert_or_seal_twice_once_sealed() {
    let mut storage = storage(&entries(0, 2));

    assert_eq!(
        storage.insert(BASE_TIMESTAMP as u64, negentropy_id(&event_id("late"))),
        Err(NegentropyError::AlreadySealed)
    );
    assert_eq!(storage.seal(), Err(NegentropyError::AlreadySealed));
}

#[test]
fn refuses_to_be_read_before_it_is_sealed() {
    let storage = NegentropyStorageVector::new();

    assert_eq!(storage.size(), Err(NegentropyError::NotSealed));
    assert!(matches!(
        storage.fingerprint(0, 0),
        Err(NegentropyError::NotSealed)
    ));
}

#[test]
fn sorts_by_timestamp_then_by_id() {
    let low = NegentropyId::from_byte_array([0x01; 32]);
    let high = NegentropyId::from_byte_array([0x02; 32]);
    let mut storage = NegentropyStorageVector::new();

    storage.insert(BASE_TIMESTAMP as u64 + 1, low).unwrap();
    storage.insert(BASE_TIMESTAMP as u64, high).unwrap();
    storage.insert(BASE_TIMESTAMP as u64, low).unwrap();
    storage.seal().unwrap();

    let mut order = Vec::new();
    storage
        .iterate(0, storage.size().unwrap(), &mut |item, _| {
            order.push((item.timestamp - BASE_TIMESTAMP as u64, item.id[0]));
            Ok(true)
        })
        .unwrap();

    assert_eq!(order, vec![(0, 1), (0, 2), (1, 1)]);
}

#[test]
fn finds_the_lower_bound_of_a_bound() {
    let storage = storage(&entries_with(0, 10, 1));

    assert_eq!(
        storage.find_lower_bound(0, 10, &Bound::with_timestamp(0)),
        0
    );
    assert_eq!(
        storage.find_lower_bound(0, 10, &Bound::with_timestamp(BASE_TIMESTAMP as u64 + 3)),
        3
    );
    assert_eq!(
        storage.find_lower_bound(0, 10, &Bound::with_timestamp(BASE_TIMESTAMP as u64 + 99)),
        10
    );
    assert_eq!(
        storage.find_lower_bound(0, 10, &Bound::with_timestamp(u64::MAX)),
        10
    );
}

#[test]
fn rejects_out_of_range_bounds() {
    let storage = storage(&entries(0, 3));

    assert_eq!(
        storage.iterate(0, 4, &mut |_, _| Ok(true)),
        Err(NegentropyError::BadRange)
    );
    assert!(matches!(
        storage.fingerprint(2, 1),
        Err(NegentropyError::BadRange)
    ));
}

#[test]
fn produces_16_byte_fingerprints_that_do_not_depend_on_insertion_order() {
    let forward_entries = entries(0, 8);
    let mut reversed = forward_entries.clone();
    reversed.reverse();

    let forward = storage(&forward_entries);
    let backward = storage(&reversed);

    assert_eq!(fingerprint(&forward, 0, 8).len(), 16);
    assert_eq!(fingerprint(&forward, 0, 8), fingerprint(&backward, 0, 8));
}

#[test]
fn produces_different_fingerprints_for_different_sets_and_for_different_counts() {
    let forward = storage(&entries(0, 8));
    let other = storage(&entries(1, 9));

    assert_ne!(fingerprint(&forward, 0, 8), fingerprint(&other, 0, 8));
    assert_ne!(fingerprint(&forward, 0, 4), fingerprint(&forward, 0, 5));
}

#[test]
fn wraps_the_256_bit_id_sum_around_carrying_across_every_32_bit_word() {
    let all_ones = NegentropyId::from_byte_array([0xff; 32]);
    let mut one = [0u8; 32];
    one[0] = 1;
    let one = NegentropyId::from_byte_array(one);
    let zero = NegentropyId::from_byte_array([0u8; 32]);

    let mut overflowing = NegentropyStorageVector::new();
    overflowing.insert(BASE_TIMESTAMP as u64, all_ones).unwrap();
    overflowing.insert(BASE_TIMESTAMP as u64, one).unwrap();
    overflowing.seal().unwrap();

    let mut zero_sum = NegentropyStorageVector::new();
    zero_sum.insert(BASE_TIMESTAMP as u64, zero).unwrap();
    zero_sum.insert(BASE_TIMESTAMP as u64 + 1, zero).unwrap();
    zero_sum.seal().unwrap();

    assert_eq!(
        fingerprint(&overflowing, 0, 2),
        fingerprint(&zero_sum, 0, 2)
    );
}

// --- the four storage-vector divergences --------------------------------------------------

#[test]
fn rejects_duplicate_items_when_sealing() {
    // Divergence 1: `seal()` de-duplicates silently instead of refusing.
    let mut storage = NegentropyStorageVector::new();
    let duplicate = negentropy_id(&event_id("dup"));

    storage.insert(BASE_TIMESTAMP as u64, duplicate).unwrap();
    storage.insert(BASE_TIMESTAMP as u64, duplicate).unwrap();
    storage.seal().unwrap();

    assert_eq!(storage.size(), Ok(1));
}

#[test]
fn hands_out_frozen_items_so_callbacks_cannot_reorder_a_sealed_set() {
    // Divergence 2: `Item` is `Copy`, so the callback holds a copy and cannot write back.
    let storage = storage(&entries(0, 2));
    let mut seen = Vec::new();

    storage
        .iterate(0, 2, &mut |item, _| {
            seen.push(item);
            Ok(true)
        })
        .unwrap();

    let mut copy = seen[0];
    copy.timestamp = 0;

    assert_ne!(copy.timestamp, seen[0].timestamp);
    assert_eq!(
        storage.get_item(0).unwrap().unwrap().timestamp,
        seen[0].timestamp
    );
}

#[test]
fn is_not_affected_by_the_caller_changing_an_id_buffer_after_inserting_it() {
    // Divergence 3: `Id` is `[u8; 32]` by value, so there is no shared buffer.
    let mut buffer = *event_id("mutable").as_bytes();
    let mut storage = NegentropyStorageVector::new();

    storage
        .insert(BASE_TIMESTAMP as u64, NegentropyId::from_byte_array(buffer))
        .unwrap();
    storage.seal().unwrap();
    let before = fingerprint(&storage, 0, 1);

    buffer.fill(0xff);

    assert_eq!(fingerprint(&storage, 0, 1), before);
}

#[test]
fn rejects_range_indexes_that_are_negative_fractional_or_not_finite() {
    // Divergence 4: the parameters are `usize`, so only `BadRange` is representable — which
    // `rejects_out_of_range_bounds` already pins. The inverted range is the whole case.
    let storage = storage(&entries(0, 3));

    assert!(matches!(
        storage.fingerprint(2, 1),
        Err(NegentropyError::BadRange)
    ));
}

// --- wire compatibility with the reference implementation (3) ----------------------------

#[test]
fn encodes_the_same_first_message_as_the_reference() {
    let mut client = Negentropy::owned(storage(&entries(0, 40)), 0).unwrap();

    assert_eq!(hex(&client.initiate().unwrap()), REFERENCE_FIRST_MESSAGE);
}

#[test]
fn answers_that_message_exactly_like_the_reference() {
    let mut server = Negentropy::owned(storage(&entries(10, 50)), 0).unwrap();

    let reply = server.reconcile(&unhex(REFERENCE_FIRST_MESSAGE)).unwrap();

    assert_eq!(hex(&reply), REFERENCE_RESPONSE);
}

#[test]
fn encodes_an_empty_set_as_a_single_empty_id_list() {
    let mut client = Negentropy::owned(storage(&[]), 0).unwrap();

    assert_eq!(hex(&client.initiate().unwrap()), "6100000200");
}

// --- reconciliation (15) -----------------------------------------------------------------

#[test]
fn finds_nothing_to_sync_between_identical_sets() {
    let entries = entries(0, 200);

    let outcome = sync(&entries, &entries, 0);

    assert_eq!(outcome.have.iter().copied().collect::<Vec<_>>(), Vec::new());
    assert_eq!(outcome.need.iter().copied().collect::<Vec<_>>(), Vec::new());
    assert_eq!(outcome.rounds, 1);
}

#[test]
fn reports_everything_as_needed_when_the_client_has_nothing() {
    let server = entries(0, 50);

    let outcome = sync(&[], &server, 0);

    assert_eq!(outcome.have.iter().copied().collect::<Vec<_>>(), Vec::new());
    assert_eq!(
        outcome.need.iter().copied().collect::<Vec<_>>(),
        ids_of(&server)
    );
}

#[test]
fn reports_everything_as_had_when_the_server_has_nothing() {
    let client = entries(0, 50);

    let outcome = sync(&client, &[], 0);

    assert_eq!(
        outcome.have.iter().copied().collect::<Vec<_>>(),
        ids_of(&client)
    );
    assert_eq!(outcome.need.iter().copied().collect::<Vec<_>>(), Vec::new());
}

#[test]
fn handles_completely_disjoint_sets() {
    let client = entries(0, 100);
    let server = entries(1000, 1100);

    let outcome = sync(&client, &server, 0);

    assert_eq!(
        outcome.have.iter().copied().collect::<Vec<_>>(),
        ids_of(&client)
    );
    assert_eq!(
        outcome.need.iter().copied().collect::<Vec<_>>(),
        ids_of(&server)
    );
}

#[test]
fn converges_on_the_exact_difference_for_500_vs_480_items() {
    assert_converges_on_the_difference(500, 480, 10);
}

#[test]
fn converges_on_the_exact_difference_for_3000_vs_2900_items() {
    assert_converges_on_the_difference(3000, 2900, 100);
}

#[test]
fn converges_on_the_exact_difference_for_40_vs_5000_items() {
    assert_converges_on_the_difference(40, 5000, 0);
}

fn assert_converges_on_the_difference(client_size: usize, server_size: usize, offset: usize) {
    let client = entries(0, client_size);
    let server = entries(0, server_size)[offset..].to_vec();

    let outcome = sync(&client, &server, 0);

    assert_eq!(
        outcome.have.iter().copied().collect::<Vec<_>>(),
        difference(&client, &server)
    );
    assert_eq!(
        outcome.need.iter().copied().collect::<Vec<_>>(),
        difference(&server, &client)
    );
}

#[test]
fn converges_when_thousands_of_events_share_one_timestamp() {
    let client = entries_with(0, 1500, 1500);
    let server = entries_with(100, 1600, 1500);

    let outcome = sync(&client, &server, 0);

    assert_eq!(
        outcome.have.iter().copied().collect::<Vec<_>>(),
        difference(&client, &server)
    );
    assert_eq!(
        outcome.need.iter().copied().collect::<Vec<_>>(),
        difference(&server, &client)
    );
}

#[test]
fn converges_under_a_small_frame_size_limit_in_more_rounds() {
    let client = entries(0, 3000);
    let server = entries(5000, 8000);

    let unlimited = sync(&client, &server, 0);
    let limited = sync(&client, &server, 4096);

    assert_eq!(
        limited.have.iter().copied().collect::<Vec<_>>(),
        difference(&client, &server)
    );
    assert_eq!(
        limited.need.iter().copied().collect::<Vec<_>>(),
        difference(&server, &client)
    );
    assert!(limited.rounds > unlimited.rounds);
}

#[test]
fn keeps_every_responder_message_within_the_frame_size_limit() {
    let frame_size_limit = 4096;
    let mut initiator = Negentropy::owned(storage(&entries(0, 3000)), 0).unwrap();
    let mut responder = Negentropy::owned(storage(&entries(5000, 8000)), frame_size_limit).unwrap();

    let mut message = Some(initiator.initiate().unwrap());

    while let Some(current) = message {
        let reply = responder.reconcile(&current).unwrap();
        assert!(reply.len() <= frame_size_limit as usize);

        let mut have_ids = Vec::new();
        let mut need_ids = Vec::new();
        message = initiator
            .reconcile_with_ids(&reply, &mut have_ids, &mut need_ids)
            .unwrap();
    }
}

#[test]
fn restarts_a_frame_truncated_reply_at_the_last_written_bound_not_after_the_dropped_range() {
    // Divergence 7 (module doc): the capture answers `fingerprint(120, 160)` here and asserts
    // it is *not* `fingerprint(160, 160)`; the crate takes the trailing fingerprint's lower
    // bound from the range it was processing, so it answers `fingerprint(160, 160)`. The
    // capture's `writtenUpTo` (`src/utils/negentropy.ts:313-317`) is what the crate lacks.
    // The next round re-offers the range, so the session still converges — pinned by
    // `still_converges_when_several_mismatched_ranges_are_cut_by_the_frame_limit`.
    let entries = entries_with(0, 160, 1);
    let storage = storage(&entries);

    let mut message = vec![0x61];
    message.extend(varint(BASE_TIMESTAMP as u64 + 120 + 1));
    message.push(0);
    message.push(2);
    message.push(0);
    message.push(0);
    message.push(0);
    message.push(1);
    message.extend([0u8; 16]);

    let reply = Negentropy::owned(storage.clone(), 4096)
        .unwrap()
        .reconcile(&message)
        .unwrap();

    let trailing = &reply[reply.len() - 16..];

    assert_eq!(trailing, fingerprint(&storage, 160, 160));
    assert_ne!(trailing, fingerprint(&storage, 120, 160));
}

#[test]
fn still_converges_when_several_mismatched_ranges_are_cut_by_the_frame_limit() {
    let client = entries_with(0, 60, 1);
    let server = entries_with(0, 3000, 1);

    let outcome = sync(&client, &server, 4096);

    assert_eq!(
        outcome.have.iter().copied().collect::<Vec<_>>(),
        difference(&client, &server)
    );
    assert_eq!(
        outcome.need.iter().copied().collect::<Vec<_>>(),
        difference(&server, &client)
    );
}

#[test]
fn rejects_frame_size_limits_below_4096() {
    assert_eq!(
        Negentropy::owned(storage(&[]), 4095).unwrap_err(),
        NegentropyError::FrameSizeLimitTooSmall
    );
    assert!(Negentropy::owned(storage(&[]), 0).is_ok());
}

#[test]
fn refuses_to_initiate_twice() {
    let mut client = Negentropy::owned(storage(&[]), 0).unwrap();
    client.initiate().unwrap();

    assert_eq!(
        client.initiate().unwrap_err(),
        NegentropyError::AlreadyBuiltInitialMessage
    );
}

#[test]
fn can_run_several_independent_sessions_over_the_same_storage() {
    let held = storage(&entries(10, 50));
    let message = Negentropy::owned(storage(&entries(0, 40)), 0)
        .unwrap()
        .initiate()
        .unwrap();

    let mut first = Negentropy::borrowed(&held, 0).unwrap();
    let mut second = Negentropy::borrowed(&held, 0).unwrap();

    assert_eq!(
        first.reconcile(&message).unwrap(),
        second.reconcile(&message).unwrap()
    );
}

// --- malformed input (10 expressible) ----------------------------------------------------

#[test]
fn rejects_an_empty_message() {
    assert_eq!(
        responder().reconcile(&[]).unwrap_err(),
        NegentropyError::ParseEndsPrematurely
    );
}

#[test]
fn rejects_a_version_byte_outside_0x60_0x6f() {
    assert_eq!(
        responder().reconcile(&[0x42]).unwrap_err(),
        NegentropyError::InvalidProtocolVersion
    );
}

#[test]
fn answers_an_unsupported_but_well_formed_version_with_just_its_own_version_byte() {
    assert_eq!(hex(&responder().reconcile(&[0x62]).unwrap()), "61");
    assert_eq!(PROTOCOL_VERSION as u8, 0x61);
}

#[test]
fn throws_when_the_initiator_is_answered_with_an_unsupported_version() {
    let mut initiator = Negentropy::owned(storage(&[]), 0).unwrap();
    initiator.initiate().unwrap();
    let mut have_ids = Vec::new();
    let mut need_ids = Vec::new();

    assert_eq!(
        initiator
            .reconcile_with_ids(&[0x62], &mut have_ids, &mut need_ids)
            .unwrap_err(),
        NegentropyError::UnsupportedProtocolVersion
    );
}

#[test]
fn rejects_an_unknown_mode() {
    assert_eq!(
        responder()
            .reconcile(&[0x61, 0x00, 0x00, 0x07])
            .unwrap_err(),
        NegentropyError::UnexpectedMode(7)
    );
}

#[test]
fn rejects_a_bound_id_longer_than_32_bytes() {
    // The crate bounds-checks the id slice before it builds the bound, so the message is
    // refused as `ParseEndsPrematurely`; `IdTooBig` is the bound constructor's own refusal.
    assert_eq!(
        responder().reconcile(&[0x61, 0x00, 33]).unwrap_err(),
        NegentropyError::ParseEndsPrematurely
    );
    assert_eq!(
        Bound::with_timestamp_and_id(BASE_TIMESTAMP as u64, [0u8; 33]).unwrap_err(),
        NegentropyError::IdTooBig
    );
}

#[test]
fn rejects_a_truncated_fingerprint() {
    assert_eq!(
        responder()
            .reconcile(&[0x61, 0x00, 0x00, 0x01, 0xaa])
            .unwrap_err(),
        NegentropyError::ParseEndsPrematurely
    );
}

#[test]
fn rejects_an_id_list_that_claims_more_ids_than_the_message_carries() {
    assert_eq!(
        responder()
            .reconcile(&[0x61, 0x00, 0x00, 0x02, 100])
            .unwrap_err(),
        NegentropyError::ParseEndsPrematurely
    );
}

#[test]
fn rejects_an_id_list_whose_declared_size_would_overflow_when_multiplied_out() {
    assert_eq!(
        responder()
            .reconcile(&[0x61, 0x00, 0x00, 0x02, 0xff, 0xff, 0xff, 0xff, 0x7f])
            .unwrap_err(),
        NegentropyError::ParseEndsPrematurely
    );
}

#[test]
fn does_not_mutate_its_storage_when_the_input_is_rejected() {
    let storage = storage(&entries(0, 100));
    let before = fingerprint(&storage, 0, 100);

    assert!(
        Negentropy::owned(storage.clone(), 0)
            .unwrap()
            .reconcile(&[0x61, 0x00, 33])
            .is_err()
    );

    assert_eq!(fingerprint(&storage, 0, 100), before);
}

// --- the two malformed-input divergences -------------------------------------------------

#[test]
fn rejects_varints_that_never_terminate() {
    // Divergence 5: the crate's decoder has no length bound, so a run of continuation bytes
    // decodes as zero and the message is accepted rather than refused.
    let endless = [
        0x61, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
    ];

    assert!(responder().reconcile(&endless).is_ok());
}

#[test]
fn rejects_varints_beyond_the_safe_integer_range() {
    // Divergence 6: the same decoder accumulates into `u64` without a safe-integer check, so
    // the message is accepted rather than refused.
    let too_big = [0x61, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f];

    assert!(responder().reconcile(&too_big).is_ok());
}
