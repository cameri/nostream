//! The streaming event importer: the JSONL and array readers, the counters and the batch
//! persister's routing.
//!
//! Mirrors `test/unit/services/event-import-service.spec.ts`.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::RefCell;
use std::sync::Arc;

use nostream_core::{Event, Kind, Signature};
use nostream_services::services::event_import_service::{
    EventBatchPersister, EventImportLineError, EventImportService, EventImportStats, ImportOptions,
    LineErrorSink, RepositoryEventPersister,
};
use nostream_services::testing::{self, InMemoryEventRepository, RecordingPersister};
use tokio::io::BufReader;

/// The trait-object views the service and the persister take.
fn service(persister: &Arc<RecordingPersister>) -> EventImportService {
    let cloned = Arc::clone(persister);

    EventImportService::new(cloned)
}

fn repository_persister(repository: &Arc<InMemoryEventRepository>) -> RepositoryEventPersister {
    let cloned = Arc::clone(repository);

    RepositoryEventPersister::new(cloned)
}

/// A signed, schema-valid text note.
fn valid_event() -> Event {
    testing::signed_event(&[1; 32], Kind::TEXT_NOTE, vec![], "hello")
}

fn line(event: &Event) -> String {
    serde_json::to_string(event).expect("serialize")
}

fn tagged(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

#[tokio::test]
async fn jsonl_imports_in_default_sized_batches() {
    let persister = RecordingPersister::new();
    let service = service(&persister);
    let serialized = line(&valid_event());
    let input = vec![serialized.as_str(); 2_500].join("\n");

    let stats = service
        .import_jsonl(BufReader::new(input.as_bytes()), &ImportOptions::default())
        .await
        .expect("import");

    assert_eq!(
        stats,
        EventImportStats {
            processed: 2_500,
            inserted: 2_500,
            skipped: 0,
            errors: 0,
        }
    );
    let sizes: Vec<usize> = persister.batches().iter().map(std::vec::Vec::len).collect();
    assert_eq!(sizes, [1_000, 1_000, 500]);
}

#[tokio::test]
async fn a_bad_line_is_counted_and_the_import_continues() {
    let persister = RecordingPersister::new();
    let service = service(&persister);
    let sink = RefCell::new(LineErrorSink::default());
    let mut input = vec!["not json"; 21].join("\n");
    input.push('\n');
    input.push_str(&line(&valid_event()));

    let on_line_error = |error: &EventImportLineError| {
        sink.borrow_mut().record(error);
    };
    let options = ImportOptions {
        batch_size: 1_000,
        on_line_error: Some(&on_line_error),
        on_progress: None,
    };

    let stats = service
        .import_jsonl(BufReader::new(input.as_bytes()), &options)
        .await
        .expect("a bad line does not stop the import");

    assert_eq!(stats.processed, 22);
    assert_eq!(stats.errors, 21);
    assert_eq!(stats.inserted, 1);
    assert_eq!(persister.batches().len(), 1, "the valid line still landed");

    let sink = sink.into_inner();
    assert_eq!(sink.printed.len(), 20, "at most 20 line errors are printed");
    assert_eq!(sink.suppressed, 1);
}

#[tokio::test]
async fn the_array_reader_flushes_before_a_parse_error_surfaces() {
    let persister = RecordingPersister::new();
    let service = service(&persister);
    let input = format!("[{}, nope]", line(&valid_event()));
    let options = ImportOptions {
        batch_size: 1,
        on_line_error: None,
        on_progress: None,
    };

    let error = service
        .import_json_array(input.as_bytes(), &options)
        .await
        .expect_err("a malformed element fails the import");

    assert!(
        error.to_string().starts_with("Invalid JSON array input: "),
        "{error}"
    );
    assert_eq!(
        persister.batches().len(),
        1,
        "the first element was persisted before the second failed to parse"
    );
}

#[tokio::test]
async fn a_non_array_input_is_refused() {
    let persister = RecordingPersister::new();
    let service = service(&persister);

    let error = service
        .import_json_array(&b"{\"a\":1}"[..], &ImportOptions::default())
        .await
        .expect_err("an object is not an array");

    assert_eq!(
        error.to_string(),
        "Invalid JSON array input: expected `[`, found `{`"
    );
}

#[tokio::test]
async fn a_json_array_reports_the_same_counters_as_jsonl() {
    let persister = RecordingPersister::new();
    let service = service(&persister);
    let serialized = line(&valid_event());
    let input = format!("[{}]", vec![serialized.as_str(); 2_500].join(","));

    let stats = service
        .import_json_array(input.as_bytes(), &ImportOptions::default())
        .await
        .expect("import");

    assert_eq!(
        stats,
        EventImportStats {
            processed: 2_500,
            inserted: 2_500,
            skipped: 0,
            errors: 0,
        }
    );
    let sizes: Vec<usize> = persister.batches().iter().map(std::vec::Vec::len).collect();
    assert_eq!(sizes, [1_000, 1_000, 500]);
}

#[tokio::test]
async fn an_impossible_insert_count_fails_the_import() {
    let serialized = line(&valid_event());
    let input = [serialized.as_str(); 4].join("\n");

    for (count, message) in [
        (-1.0, "Invalid insert count (-1) for batch size 2"),
        (1.5, "Invalid insert count (1.5) for batch size 2"),
        (3.0, "Invalid insert count (3) for batch size 2"),
    ] {
        let persister = RecordingPersister::new();
        persister.return_count(count);
        let service = service(&persister);
        let options = ImportOptions {
            batch_size: 2,
            on_line_error: None,
            on_progress: None,
        };

        let error = service
            .import_jsonl(BufReader::new(input.as_bytes()), &options)
            .await
            .expect_err("an impossible count fails the flush");

        assert_eq!(error.to_string(), message);
        assert_eq!(
            persister.batches().len(),
            1,
            "no flush follows a rejected one"
        );
    }
}

async fn persist(persister: &RepositoryEventPersister, events: &[Event]) -> f64 {
    EventBatchPersister::persist(persister, events)
        .await
        .expect("persist")
}

#[tokio::test]
async fn the_persister_routes_ephemeral_delete_and_replaceable_events() {
    let repository = InMemoryEventRepository::new();
    let persister = repository_persister(&repository);

    // Ephemeral rows are never written.
    let ephemeral = testing::signed_event(&[2; 32], Kind(20_001), vec![], "ephemeral");
    assert_eq!(
        persist(&persister, std::slice::from_ref(&ephemeral)).await,
        0.0
    );
    assert!(repository.creates().is_empty());
    let written_ids: Vec<String> = repository
        .create_many_calls()
        .into_iter()
        .chain(repository.upsert_many_calls())
        .flatten()
        .map(|record| record.event.id.to_string())
        .collect();
    assert!(
        !written_ids.contains(&ephemeral.id.to_string()),
        "an ephemeral event is never written"
    );

    // A delete flushes what is pending, deletes its 64-hex `e` ids and stores itself.
    let repository = InMemoryEventRepository::new();
    let persister = repository_persister(&repository);
    let regular = testing::signed_event(&[3; 32], Kind::TEXT_NOTE, vec![], "regular");
    let replaceable = testing::signed_event(&[3; 32], Kind::METADATA, vec![], "{}");
    let deletable = "ab".repeat(32);
    let delete = testing::signed_event(
        &[3; 32],
        Kind::DELETE,
        vec![
            tagged(&["e", &deletable]),
            tagged(&["e", &"AB".repeat(32)]),
            tagged(&["e", "abcd"]),
        ],
        "",
    );

    let inserted = persist(
        &persister,
        &[regular.clone(), replaceable.clone(), delete.clone()],
    )
    .await;

    let create_batches = repository.create_many_calls();
    assert_eq!(create_batches.len(), 2, "the regular row flushes first");
    assert_eq!(create_batches[0].len(), 1);
    assert_eq!(create_batches[0][0].event.id, regular.id);
    assert!(create_batches[1].is_empty(), "nothing regular is left over");

    let upsert_batches = repository.upsert_many_calls();
    assert_eq!(upsert_batches.len(), 2);
    assert_eq!(upsert_batches[0][0].event.id, replaceable.id);

    assert_eq!(
        repository.deletes(),
        [(delete.pubkey, vec![deletable.parse().expect("a 64-hex id")])],
        "only 64 lowercase hex `e` tags are soft-deleted"
    );
    assert_eq!(repository.creates().len(), 1);
    assert_eq!(repository.creates()[0].event.id, delete.id);
    assert_eq!(inserted, 3.0);

    // Replaceable and parameterized-replaceable rows are upserted.
    let repository = InMemoryEventRepository::new();
    let persister = repository_persister(&repository);
    let metadata = testing::signed_event(&[4; 32], Kind::METADATA, vec![], "{}");
    let parameterized = testing::signed_event(
        &[4; 32],
        Kind(30_001),
        vec![tagged(&["d", "first"]), tagged(&["d", "second"])],
        "",
    );

    persist(&persister, &[metadata.clone(), parameterized.clone()]).await;

    let upserted: Vec<Event> = repository
        .upsert_many_calls()
        .into_iter()
        .flatten()
        .map(|record| record.event)
        .collect();
    assert_eq!(
        upserted.iter().map(|event| event.id).collect::<Vec<_>>(),
        [metadata.id, parameterized.id]
    );
    let records: Vec<_> = repository
        .upsert_many_calls()
        .into_iter()
        .flatten()
        .collect();
    assert_eq!(
        records[1].event_deduplication,
        Some(vec![serde_json::Value::String("first".to_owned())]),
        "the first `d` tag wins"
    );
}

#[tokio::test]
async fn the_persister_enriches_deduplication_and_expiration() {
    let repository = InMemoryEventRepository::new();
    let persister = repository_persister(&repository);

    let no_tag = testing::signed_event(&[5; 32], Kind(30_002), vec![], "");
    let empty_tag = testing::signed_event(&[5; 32], Kind(30_003), vec![tagged(&["d", ""])], "");
    let expiring = testing::signed_event(
        &[5; 32],
        Kind::TEXT_NOTE,
        vec![tagged(&["expiration", "1700003600"])],
        "expires",
    );

    persist(&persister, &[no_tag, empty_tag, expiring]).await;

    let batches = repository.upsert_many_calls();
    let upserted = &batches[0];
    assert_eq!(
        upserted[0].event_deduplication,
        Some(vec![serde_json::Value::String(String::new())])
    );
    assert_eq!(
        upserted[1].event_deduplication,
        Some(vec![serde_json::Value::String(String::new())])
    );

    let created: Vec<_> = repository
        .create_many_calls()
        .into_iter()
        .flatten()
        .collect();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].expires_at, Some(1_700_003_600));
}

#[tokio::test]
async fn validation_rejects_the_id_the_signature_and_an_unknown_key() {
    let persister = RecordingPersister::new();
    let service = service(&persister);

    let mut tampered = valid_event();
    tampered.id = nostream_core::EventId::from_byte_array([0; 32]);

    let mut bad_signature = valid_event();
    let mut bytes = *bad_signature.sig.as_bytes();
    bytes[0] ^= 0xff;
    bad_signature.sig = Signature::from_byte_array(bytes);

    let mut value = serde_json::to_value(valid_event()).expect("to value");
    value
        .as_object_mut()
        .expect("an object")
        .insert("extra".to_owned(), serde_json::Value::Bool(true));
    let unknown_key = serde_json::to_string(&value).expect("serialize");

    let input = [line(&tampered), line(&bad_signature), unknown_key].join("\n");

    let reasons: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let on_line_error =
        |error: &EventImportLineError| reasons.borrow_mut().push(error.reason.clone());
    let options = ImportOptions {
        batch_size: 1_000,
        on_line_error: Some(&on_line_error),
        on_progress: None,
    };

    let stats = service
        .import_jsonl(BufReader::new(input.as_bytes()), &options)
        .await
        .expect("bad events are line errors, not import failures");

    assert_eq!(stats.errors, 3);
    assert_eq!(stats.inserted, 0);
    assert!(
        persister.batches().is_empty(),
        "a rejected event never reaches the persister"
    );

    let reasons = reasons.into_inner();
    assert_eq!(reasons[0], "invalid: event id does not match");
    assert_eq!(reasons[1], "invalid: event signature verification failed");
    assert!(
        reasons[2].contains("unknown field `extra`"),
        "the schema's own message names the unknown key: {}",
        reasons[2]
    );
}
