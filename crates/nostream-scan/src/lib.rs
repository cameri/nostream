//! The byte scanner that finds where one JSON array element ends.
//!
//! Extraction, not invention: this module was `ElementEnd` and `ends_scalar`
//! inside `nostream-services`' event-import reader, moved here verbatim so the
//! Kani proofs in [`proofs`] can run against it without compiling the services
//! crate's dependency graph (tokio, reqwest, secp256k1's C sources, sqlx). The
//! reader is the only caller and it calls this code — there is no copy to drift.
//!
//! What it does: given the bytes of one element, starting at the element's
//! first byte and arriving in pieces across reads, it reports whether the
//! element's last byte has been seen. It understands exactly what can hide an
//! element's end — string contents and escapes, and bracket depth — and
//! nothing else; judging the element's grammar is the parser's job.
//!
//! Why it can be trusted with a buffer: an element whose brackets never balance
//! looks unfinished until the end of input, so [`ElementEnd::probe_due`] hands
//! a growing element to the parser at doubling thresholds from
//! [`FIRST_PROBE`]. That bounds a malformed element's buffering to about twice
//! the offset of its fault, and keeps parsing linear — the tries sum to less
//! than twice the element.

mod element_end;

pub use element_end::{ElementEnd, FIRST_PROBE};

#[cfg(kani)]
mod proofs;
