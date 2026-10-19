//! The differential oracle: the capture's own measurement, replayed through this crate's
//! public API.
//!
//! `tests/fixtures/ts-events.json` is generated data, not hand-written: 1,000 events and 50
//! negative events put through the TypeScript at `242a3001` by
//! `tests/capture/gen-ts-events.mjs` (the capture's `getEventHash` / `identifyEvent` /
//! `isEventIdValid` / `isEventSignatureValid` / `isEventMatchingFilter` /
//! `getEventProofOfWork` / `serializeEvent`). For every entry this module requires:
//!
//! - `canonical_json` equals the captured `serialized` bytes,
//! - `compute_event_id` reproduces `event.id` exactly when `id_ok`,
//! - `verify_event_signature` succeeds exactly when `sig_ok`,
//! - `leading_zero_bits(event.id)` equals `pow`,
//! - every probe filter's `matches` equals the recorded boolean.
//!
//! The fixture is a committed measurement. A missing or unreadable file is a **failure**,
//! never a skip (`CLAUDE.md:151-152`).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;

use nostream_core::crypto::{compute_event_id, verify_event_signature};
use nostream_core::event::{Event, canonical_json};
use nostream_core::filter::Filter;
use nostream_core::pow::leading_zero_bits;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    subject: String,
    generated_by: String,
    seed: String,
    event_count: usize,
    negative_count: usize,
    filters: Vec<ProbeFilter>,
    events: Vec<Entry>,
    negative_events: Vec<Entry>,
}

#[derive(Debug, Deserialize)]
struct ProbeFilter {
    label: String,
    filter: serde_json::Value,
    true_count: usize,
}

#[derive(Debug, Deserialize)]
struct Entry {
    event: Event,
    serialized: String,
    id_ok: bool,
    sig_ok: bool,
    pow: u32,
    matches: Vec<bool>,
}

fn fixture() -> Fixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-events.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));

    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn filters(fixture: &Fixture) -> Vec<Filter> {
    fixture
        .filters
        .iter()
        .map(|probe| serde_json::from_value(probe.filter.clone()).unwrap())
        .collect()
}

fn entries(fixture: &Fixture) -> impl Iterator<Item = &Entry> {
    fixture.events.iter().chain(fixture.negative_events.iter())
}

#[test]
fn fixture_metadata_records_the_measurement() {
    let fixture = fixture();

    assert_eq!(fixture.subject, "242a3001d77149e4d70151ec03060c4ef44a1547");
    assert_eq!(
        fixture.generated_by,
        "crates/nostream-core/tests/capture/gen-ts-events.mjs"
    );
    assert_eq!(fixture.seed, "nostream-006");
    assert_eq!(fixture.event_count, 1_000);
    assert_eq!(fixture.events.len(), 1_000);
    assert_eq!(fixture.negative_count, 50);
    assert_eq!(fixture.negative_events.len(), 50);
    assert_eq!(fixture.filters.len(), 16);
}

#[test]
fn every_event_serialises_to_the_captured_bytes() {
    let fixture = fixture();

    for (index, entry) in entries(&fixture).enumerate() {
        assert_eq!(
            canonical_json(&entry.event).unwrap(),
            entry.serialized,
            "entry {index}"
        );
    }
}

#[test]
fn every_id_decision_matches_the_capture() {
    let fixture = fixture();

    for (index, entry) in entries(&fixture).enumerate() {
        let computed = compute_event_id(&entry.event).unwrap();
        let reproduces = computed == entry.event.id;

        assert_eq!(
            reproduces, entry.id_ok,
            "entry {index} (id {})",
            entry.event.id
        );
    }
}

#[test]
fn every_signature_decision_matches_the_capture() {
    let fixture = fixture();

    for (index, entry) in entries(&fixture).enumerate() {
        let verifies = verify_event_signature(&entry.event).is_ok();

        assert_eq!(
            verifies, entry.sig_ok,
            "entry {index} (id {})",
            entry.event.id
        );
    }
}

#[test]
fn every_pow_decision_matches_the_capture() {
    let fixture = fixture();

    for (index, entry) in entries(&fixture).enumerate() {
        assert_eq!(
            leading_zero_bits(entry.event.id.as_bytes()),
            entry.pow,
            "entry {index} (id {})",
            entry.event.id
        );
    }
}

#[test]
fn every_filter_decision_matches_the_capture() {
    let fixture = fixture();
    let filters = filters(&fixture);

    assert_eq!(filters.len(), fixture.filters.len());

    for (index, entry) in entries(&fixture).enumerate() {
        assert_eq!(entry.matches.len(), filters.len(), "entry {index}");

        for (position, filter) in filters.iter().enumerate() {
            assert_eq!(
                filter.matches(&entry.event),
                entry.matches[position],
                "entry {index}, filter {}",
                fixture.filters[position].label
            );
        }
    }
}

#[test]
fn the_fifty_negative_events_replay_identically() {
    let fixture = fixture();

    assert_eq!(fixture.negative_events.len(), 50);

    for (index, entry) in fixture.negative_events.iter().enumerate() {
        assert!(!entry.id_ok, "negative {index} must not validate its id");
        assert_eq!(
            verify_event_signature(&entry.event).is_ok(),
            entry.sig_ok,
            "negative {index}"
        );
    }

    let signature_failures = fixture
        .negative_events
        .iter()
        .filter(|entry| !entry.sig_ok)
        .count();
    let signature_passes = fixture
        .negative_events
        .iter()
        .filter(|entry| entry.sig_ok)
        .count();

    assert_eq!(signature_failures, 25);
    assert_eq!(signature_passes, 25);
}

#[test]
fn every_probe_filter_sees_at_least_one_event_of_each_decision() {
    let fixture = fixture();

    for (position, probe) in fixture.filters.iter().enumerate() {
        let true_count = fixture
            .events
            .iter()
            .filter(|entry| entry.matches[position])
            .count();

        assert_eq!(true_count, probe.true_count, "{}", probe.label);
        assert!(true_count > 0, "{} matched nothing", probe.label);
        assert!(
            true_count < fixture.events.len()
                || probe.label.ends_with("ignored")
                || probe.true_count == 1_000,
            "{} matched everything",
            probe.label
        );
    }
}
