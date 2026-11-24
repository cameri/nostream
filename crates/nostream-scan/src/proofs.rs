//! Kani harnesses for the element scanner.
//!
//! Compiled only under `cargo kani`, which sets `cfg(kani)`; a normal build
//! compiles none of this. Each harness states one property of
//! [`ElementEnd`] over *all* inputs it abstracts, not over a sample the author
//! thought of — that is the point of using a verifier here rather than more
//! unit tests, and it is why these live beside the code they prove instead of
//! in a document.
//!
//! Run them with the sidecar: `containers/kani/kn-run cargo kani -p
//! nostream-scan`. Cargo itself is not enough — `cargo kani setup` must have
//! run once inside the image, and `RUSTUP_TOOLCHAIN=kani` must be set so the
//! repository's own `rust-toolchain.toml` pin does not hijack the verifier's
//! toolchain.
//!
//! A proof that is never seen to fail proves nothing (the same rule the factory
//! reviewers apply to tests), so each harness here has a recorded broken
//! variant that produces a counterexample; see `containers/kani/README.md`.

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
        kani::assert(
            end.next_probe() >= len,
            "the next threshold is past the length just probed",
        );
        kani::assert(
            end.next_probe() >= before,
            "the threshold never moves backwards",
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

/// Scanning the same bytes twice finds the same end, and the second pass never
/// rescans a byte it has already consumed (that is what makes the reader linear,
/// not quadratic, in an element that arrives in small reads).
#[kani::proof]
#[kani::unwind(7)]
fn scanning_is_idempotent_and_forward_only() {
    let len: usize = kani::any();
    kani::assume(len >= 1 && len <= 4);
    let bytes: [u8; 4] = kani::any();

    let mut end = ElementEnd::default();
    let first = end.reached(&bytes[..len]);
    let scanned_after_first = end.scanned();
    let second = end.reached(&bytes[..len]);

    kani::assert(
        first == second,
        "a second pass cannot find an end the first missed",
    );
    kani::assert(
        end.scanned() == scanned_after_first,
        "a second pass over the same bytes consumes nothing new",
    );
}
