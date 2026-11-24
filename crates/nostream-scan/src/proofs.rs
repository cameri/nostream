//! Kani harnesses for the element scanner.
//!
//! Compiled only under `cargo kani`, which sets `cfg(kani)`; a normal build
//! compiles none of this. Each harness states one property of
//! [`ElementEnd`] over *all* inputs it abstracts, not over a sample the author
//! thought of — that is the point of using a verifier here rather than more
//! unit tests, and it is why these live beside the code they prove instead of
//! in a document.
//!
//! Running them needs nothing but Rust and the verifier:
//!
//! ```text
//! cargo install --locked kani-verifier --version 0.68.0
//! cargo kani setup
//! cargo kani -p nostream-scan
//! ```
//!
//! `cargo kani setup` installs the nightly the verifier was built against, so the
//! repository's own `rust-toolchain.toml` pin is irrelevant to these runs — that is
//! also why CI installs the verifier rather than a toolchain. A normal build
//! compiles none of this file, and `cargo test` proves nothing about it.
//!
//! A proof that is never seen to fail proves nothing (the same rule the reviewers
//! apply to tests). Each harness here has a broken variant that produces a
//! counterexample, and the way to see it is in the harness's own doc comment.

use super::{ElementEnd, FIRST_PROBE};

/// Driving the scanner with any bytes, in any order, never panics.
///
/// The reader indexes a buffer with the offset this state machine produces, so
/// an arithmetic fault here is an indexing fault there. Four bytes is enough to
/// reach every branch: a leading opener, a quote, a backslash and a closer
/// exercise string, escape and depth handling; the proof covers all 2^32
/// prefixes, including the ones no test would write.
#[kani::proof]
#[kani::unwind(7)]
fn any_bytes_never_panic() {
    let len: usize = kani::any();
    kani::assume(len <= 4);
    let bytes: [u8; 4] = kani::any();

    let mut end = ElementEnd::default();
    let _ = end.reached(&bytes[..len]);
    // The reader's two follow-ups, in the order it makes them.
    end.resume();
    let _ = end.reached(&bytes[..len]);
    let _ = end.probe_due(len);
}

/// A scalar of any length at or past the threshold is handed to the parser.
///
/// This is the regression that motivated the probe: a scalar made of bytes that
/// cannot end one — `[` followed by megabytes of `x` — used to buffer to the end
/// of input, because the probe path skipped scalars. With the scanner driven
/// into its scalar state first, the harness fails on that code and passes now.
#[kani::proof]
fn a_scalar_is_probed_on_the_same_schedule() {
    let len: usize = kani::any();
    kani::assume(len >= FIRST_PROBE && len <= FIRST_PROBE * 4);

    let mut end = ElementEnd::default();
    // One letter byte: not an opener, not a quote, and not a byte that ends a
    // scalar — so the element is a scalar whose end the scan cannot see.
    end.reached(b"x");

    kani::assert(
        end.probe_due(len),
        "an unfinished scalar past FIRST_PROBE must be handed to the parser",
    );
}

/// The probe threshold never goes backwards, and a probe is never due below it.
///
/// Reads arrive in arbitrary sizes, so the length handed to `probe_due` is
/// symbolic: what matters is that the schedule cannot oscillate (which would
/// re-parse the same element repeatedly) and cannot stall (which would let the
/// buffer grow unbounded).
#[kani::proof]
fn the_probe_schedule_only_advances() {
    let len: usize = kani::any();
    kani::assume(len <= FIRST_PROBE * 4);

    let mut end = ElementEnd::default();
    let before = end.next_probe();
    kani::assert(
        before == FIRST_PROBE,
        "the first probe is at the documented size",
    );

    let due = end.probe_due(len);

    kani::assert(
        due == (len >= FIRST_PROBE),
        "a probe is due exactly at the threshold",
    );
    if due {
        // Doubling, not merely "at least this length": a schedule that moved the
        // threshold to `len` would satisfy a weaker check and re-parse on every
        // later read, because the next read is never shorter.
        kani::assert(
            end.next_probe() >= len.saturating_mul(2),
            "the next threshold is at least twice the length just probed",
        );
        kani::assert(
            end.next_probe() >= before,
            "the threshold never moves backwards",
        );
        kani::assert(
            !end.probe_due(len),
            "the same length is not probed twice, so a stalled reader cannot re-parse",
        );
    } else {
        kani::assert(end.next_probe() == before, "no probe, no threshold move");
    }
}

/// Consuming the separator after a scalar always makes progress.
///
/// `resume` exists for the case where the parser read past the delimiter the
/// scan stopped on. If it left the offset where it found it, the next scan
/// would stop on the same byte and the reader would spin. The harness drives
/// the scanner to a finding of any kind and asserts that resuming a scalar
/// strictly advances the offset.
#[kani::proof]
#[kani::unwind(7)]
fn resume_past_a_scalar_advances() {
    let len: usize = kani::any();
    kani::assume(len >= 1 && len <= 4);
    let bytes: [u8; 4] = kani::any();

    let mut end = ElementEnd::default();
    let found = end.reached(&bytes[..len]);
    if !found {
        return;
    }

    let before = end.scanned();
    end.resume();

    if end.is_scalar() {
        kani::assert(
            end.scanned() > before,
            "resuming a scalar must step over its delimiter",
        );
    } else {
        kani::assert(
            end.scanned() == before,
            "a container or string resumes where it stopped",
        );
    }
}

/// Work is linear in the element's length: bytes examined equal bytes consumed.
///
/// The reachable failure is quadratic parsing — a scanner that restarts on every call
/// still finds the same end and leaves the same offset, so an answer-only check passes
/// while every read re-walks the element. Two statements pin it down:
///
/// - a second pass over a slice already seen examines none of it again, and
/// - across calls, `visits` never exceeds `scanned` by more than the one byte a
///   found delimiter re-examines — so the work is bounded by the element, not by
///   the product of element length and read count.
///
/// One honest limit: a variant that wipes the whole scanner (`*self =
/// Self::default()`) wipes the counter with it, so it defeats a measurement the
/// struct hosts. That is why the property asserts the relationship between visits
/// and the offset rather than an absolute count, and why the reader's contract is
/// one scanner per element — `ArrayStream` constructs one and keeps it for the
/// element's whole life.
#[kani::proof]
#[kani::unwind(9)]
fn a_second_pass_examines_nothing_new() {
    let short: usize = kani::any();
    let long: usize = kani::any();
    kani::assume(short <= long && long <= 4);
    let bytes: [u8; 4] = kani::any();

    let mut end = ElementEnd::default();
    let first = end.reached(&bytes[..short]);
    let visits_after_short = end.visits();
    kani::assert(
        visits_after_short <= end.scanned() + 1,
        "examining a slice costs no more than consuming it",
    );

    // The reader's second call: the same prefix again, as a growing buffer does.
    let repeat = end.reached(&bytes[..short]);
    kani::assert(
        first == repeat,
        "a second pass cannot find an end the first missed",
    );
    kani::assert(
        end.visits() == visits_after_short,
        "a second pass over bytes already seen examines none of them",
    );

    // Then the whole slice: the work stays proportional to what has been consumed.
    let _ = end.reached(&bytes[..long]);
    kani::assert(
        end.visits() <= end.scanned() + 1,
        "every byte is examined at most once, plus at most one delimiter re-check",
    );
}
