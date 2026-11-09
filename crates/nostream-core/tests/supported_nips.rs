//! R2: the advertisement is the audited set.
//!
//! `SUPPORTED_NIPS` is the Phase 0 audit's `must-have` list plus NIP-67
//! (`docs/rewrite/nip-parity.md` §2, §10). The literal below is written out again rather than
//! compared against the constant, so the tests fail on a missing id, an extra id, a wrong id a
//! reordering or a duplicate — and on nothing else.
//!
//! Two limits are worth stating, because they are what these tests do **not** prove:
//!
//! - **No client is told this list.** Nothing in the workspace serves a NIP-11 document or
//!   listens on HTTP (`docs/rewrite/nip-parity.md` §10, decision D1), so this is a test of the
//!   decision record and not of a response.
//! - **No behaviour behind an id.** A NIP in the list is claimed, not shown, here; the
//!   behaviour is the per-NIP table's and the harness map's business (`§10`).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nostream_core::constants::SUPPORTED_NIPS;

#[test]
fn the_advertisement_is_the_audited_set() {
    assert_eq!(
        SUPPORTED_NIPS,
        [
            1, 2, 3, 4, 5, 9, 11, 12, 13, 14, 16, 17, 20, 22, 25, 28, 33, 40, 42, 43, 44, 45, 50,
            56, 59, 62, 65, 66, 67, 70, 77, 89, 90, 98,
        ]
    );
}

#[test]
fn the_advertisement_is_ascending_and_free_of_duplicates() {
    for pair in SUPPORTED_NIPS.windows(2) {
        assert!(
            pair[0] < pair[1],
            "the advertisement must ascend strictly, found {} then {}",
            pair[0],
            pair[1]
        );
    }
}
