//! The migration seam's canonical projection and key bytes, with no driver compiled in.
//!
//! This target is also the proof that the seam builds without either backend: it runs under
//! `cargo test -p nostream-storage --no-default-features --test migration_seam`.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use chrono::{DateTime, TimeZone, Utc};
use nostream_core::{Event, EventId, Kind, Pubkey, Signature};
use nostream_storage::migration::MigrationRow;
use nostream_storage::repositories::{EventRecord, Report, ReportType};

fn instant(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text)
        .expect("a fixture instant")
        .with_timezone(&Utc)
}

/// An event record with the given row id, content and `first_seen`.
fn record(row_id: Option<&str>, content: &str, first_seen: DateTime<Utc>) -> EventRecord {
    EventRecord {
        row_id: row_id.map(str::to_owned),
        event: Event {
            id: EventId::from_byte_array([7; 32]),
            pubkey: Pubkey::from_byte_array([1; 32]),
            created_at: 1_577_836_800,
            kind: Kind::TEXT_NOTE,
            tags: Vec::new(),
            content: content.to_owned(),
            sig: Signature::from_byte_array([9; 64]),
        },
        first_seen: Some(first_seen),
        deleted_at: None,
        expires_at: None,
        event_deduplication: None,
        remote_address: None,
    }
}

fn canonical(row: &MigrationRow) -> Vec<u8> {
    row.canonical().expect("a row serialises")
}

#[test]
fn the_canonical_projection_drops_the_row_id_and_truncates_instants() {
    let epoch = instant("2020-01-01T00:00:00Z");

    // `events.id` is the one column the store does not keep, so it is not in the bytes.
    let with_row_id = canonical(&MigrationRow::Event(record(
        Some("6f1e7c1a-0000-4000-8000-000000000000"),
        "a",
        epoch,
    )));
    assert_eq!(
        with_row_id,
        canonical(&MigrationRow::Event(record(None, "a", epoch)))
    );
    assert!(!with_row_id.is_empty());

    // Every instant is truncated to the microsecond precision a `timestamp` column has.
    let nanos = Utc
        .timestamp_opt(1_577_836_800, 123_456_789)
        .single()
        .expect("a nanosecond instant");
    let micros = Utc
        .timestamp_opt(1_577_836_800, 123_456_000)
        .single()
        .expect("the same instant at microseconds");
    assert_eq!(
        canonical(&MigrationRow::Event(record(None, "a", nanos))),
        canonical(&MigrationRow::Event(record(None, "a", micros)))
    );

    // A projection that returns one constant fails both of these.
    assert_ne!(
        canonical(&MigrationRow::Event(record(None, "a", epoch))),
        canonical(&MigrationRow::Event(record(None, "b", epoch))),
        "one wire field apart is different bytes"
    );
    // `timestamp_opt`'s second argument is nanoseconds, so one microsecond is a thousand.
    let one_microsecond_later = Utc
        .timestamp_opt(1_577_836_800, 1_000)
        .single()
        .expect("one microsecond later");
    assert_ne!(
        canonical(&MigrationRow::Event(record(None, "a", epoch))),
        canonical(&MigrationRow::Event(record(
            None,
            "a",
            one_microsecond_later
        ))),
        "a projection that truncates to whole seconds fails here"
    );

    // The whole literal, so an empty, truncated or re-ordered projection fails.
    let report = MigrationRow::Report(Report {
        id: 1,
        event_id: EventId::from_byte_array([0; 32]),
        reporter_pubkey: Pubkey::from_byte_array([0; 32]),
        reported_pubkey: None,
        reported_event_id: None,
        report_type: ReportType::Spam,
        weight: 1.0,
        actionable: true,
        created_at: epoch,
    });
    let zeros = "0".repeat(64);
    let expected = format!(
        concat!(
            "{{\"Report\":{{\"id\":1,\"event_id\":\"{}\",\"reporter_pubkey\":\"{}\",",
            "\"reported_pubkey\":null,\"reported_event_id\":null,\"report_type\":\"spam\",",
            "\"weight\":1.0,\"actionable\":true,\"created_at\":\"2020-01-01T00:00:00Z\"}}}}"
        ),
        zeros, zeros
    );
    assert_eq!(
        String::from_utf8(canonical(&report)).expect("the projection is utf-8"),
        expected
    );

    // The key bytes are the store's: the raw id and the flip-signed `reports.id`.
    let event = record(None, "a", epoch);
    assert_eq!(
        MigrationRow::Event(event.clone()).key(),
        event.event.id.as_bytes().to_vec()
    );
    assert_eq!(report.key(), vec![0x80, 0x00, 0x00, 0x01]);
}
