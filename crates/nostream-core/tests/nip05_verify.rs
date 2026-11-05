//! `nostream_core::nip05::verify` against a fake transport.
//!
//! Mirrors `test/unit/utils/nip05.spec.ts`. Core owns the seam and the outcome mapping;
//! `nostream-services` owns the reqwest transport, so no HTTP is made here.
//!
//! This target may unwrap and panic: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use nostream_core::CoreError;
use nostream_core::nip05::{
    FetchOutcome, MAX_REDIRECTS, MAX_RESPONSE_BYTES, Nip05Fetch, VERIFICATION_TIMEOUT_MS,
    VerificationOutcome, parse_identifier, verify,
};

type FetchResult = Result<FetchOutcome, CoreError>;
type FetchFuture<'a> = Pin<Box<dyn Future<Output = FetchResult> + Send + 'a>>;

#[derive(Default)]
struct FakeFetch {
    calls: Mutex<Vec<(String, u64, usize, usize)>>,
    response: Mutex<Option<FetchResult>>,
}

impl FakeFetch {
    fn with(response: FetchResult) -> Arc<Self> {
        let fetch = Self::default();
        *fetch
            .response
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(response);

        Arc::new(fetch)
    }

    fn calls(&self) -> Vec<(String, u64, usize, usize)> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Nip05Fetch for FakeFetch {
    fn get<'a>(
        &'a self,
        url: &'a str,
        timeout_ms: u64,
        max_bytes: usize,
        max_redirects: usize,
    ) -> FetchFuture<'a> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((url.to_owned(), timeout_ms, max_bytes, max_redirects));

            self.response
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .map(|result| match result {
                    Ok(outcome) => Ok(outcome.clone()),
                    Err(error) => Err(CoreError::Fetch(error.to_string())),
                })
                .unwrap_or_else(|| Err(CoreError::Fetch("no scripted response".to_owned())))
        })
    }
}

fn document(entries: &[(&str, &str)]) -> Vec<u8> {
    let names: serde_json::Map<String, serde_json::Value> = entries
        .iter()
        .map(|(name, pubkey)| ((*name).to_owned(), serde_json::json!(pubkey)))
        .collect();

    serde_json::to_vec(&serde_json::json!({ "names": names })).expect("serialize")
}

fn pubkey(byte: u8) -> String {
    format!("{byte:02x}").repeat(32)
}

#[tokio::test]
async fn a_registered_pubkey_is_verified_and_another_is_a_mismatch() {
    let registered = pubkey(0x11);
    let fetch = FakeFetch::with(Ok(FetchOutcome {
        status: 200,
        body: document(&[("alice", &registered)]),
    }));

    let outcome = verify(fetch.as_ref(), "Alice@example.com", &registered).await;
    assert_eq!(outcome, VerificationOutcome::Verified);

    let calls = fetch.calls();
    assert_eq!(
        calls,
        [(
            "https://example.com/.well-known/nostr.json?name=alice".to_owned(),
            10_000,
            65_536,
            1,
        )],
        "the URL, the timeout, the body cap and the redirect budget reach the transport"
    );
    assert_eq!(VERIFICATION_TIMEOUT_MS, 10_000);
    assert_eq!(MAX_RESPONSE_BYTES, 65_536);
    assert_eq!(MAX_REDIRECTS, 1);

    let fetch = FakeFetch::with(Ok(FetchOutcome {
        status: 200,
        body: document(&[("alice", &registered)]),
    }));
    assert_eq!(
        verify(fetch.as_ref(), "alice@example.com", &pubkey(0x22)).await,
        VerificationOutcome::Mismatch
    );
}

#[tokio::test]
async fn a_body_that_is_not_the_document_is_an_error_outcome() {
    // 20 000 bytes is under the 64 KiB cap, so the failure is the parse, not the size.
    let fetch = FakeFetch::with(Ok(FetchOutcome {
        status: 200,
        body: vec![b'x'; 20_000],
    }));

    match verify(fetch.as_ref(), "alice@example.com", &pubkey(0x11)).await {
        VerificationOutcome::Error { reason } => {
            assert!(!reason.is_empty(), "the parse error is named");
        }
        other => panic!("expected an error outcome, got {other:?}"),
    }
}

#[tokio::test]
async fn a_body_over_the_cap_is_an_error_outcome() {
    let fetch = FakeFetch::with(Ok(FetchOutcome {
        status: 200,
        body: vec![b' '; MAX_RESPONSE_BYTES + 1],
    }));

    match verify(fetch.as_ref(), "alice@example.com", &pubkey(0x11)).await {
        VerificationOutcome::Error { reason } => {
            assert!(reason.contains("exceeds 65536 bytes"), "{reason}");
        }
        other => panic!("expected an error outcome, got {other:?}"),
    }
}

#[tokio::test]
async fn a_redirect_chain_beyond_the_budget_is_an_error_outcome() {
    let fetch = FakeFetch::with(Err(CoreError::Fetch(
        "too many redirects: 2 > 1".to_owned(),
    )));

    match verify(fetch.as_ref(), "alice@example.com", &pubkey(0x11)).await {
        VerificationOutcome::Error { reason } => {
            assert!(reason.contains("too many redirects"), "{reason}");
        }
        other => panic!("expected an error outcome, got {other:?}"),
    }

    assert_eq!(
        fetch.calls()[0].3,
        MAX_REDIRECTS,
        "the transport is told to follow one redirect at most"
    );
}

#[tokio::test]
async fn a_slow_endpoint_is_an_error_outcome() {
    let fetch = FakeFetch::with(Err(CoreError::Fetch(
        "request timed out after 10000 ms".to_owned(),
    )));

    match verify(fetch.as_ref(), "alice@example.com", &pubkey(0x11)).await {
        VerificationOutcome::Error { reason } => {
            assert!(reason.contains("timed out"), "{reason}");
        }
        other => panic!("expected an error outcome, got {other:?}"),
    }

    assert_eq!(
        fetch.calls()[0].1,
        VERIFICATION_TIMEOUT_MS,
        "the transport is told the 10 000 ms deadline"
    );
}

#[tokio::test]
async fn a_malformed_identifier_is_invalid_without_a_fetch() {
    let fetch = FakeFetch::with(Ok(FetchOutcome {
        status: 200,
        body: document(&[("alice", &pubkey(0x11))]),
    }));

    for identifier in [
        "not-an-identifier",
        "@example.com",
        "alice@",
        "alice@localhost",
    ] {
        assert!(
            matches!(
                verify(fetch.as_ref(), identifier, &pubkey(0x11)).await,
                VerificationOutcome::Invalid { .. }
            ),
            "{identifier} must be invalid"
        );
    }

    assert!(
        fetch.calls().is_empty(),
        "an invalid identifier is not fetched"
    );
    assert!(parse_identifier("Alice@Example.COM").is_some());
}

#[tokio::test]
async fn a_malformed_document_and_a_non_200_status_are_outcomes() {
    let fetch = FakeFetch::with(Ok(FetchOutcome {
        status: 200,
        body: serde_json::to_vec(&serde_json::json!({
            "names": { "alice": "not-a-pubkey" }
        }))
        .expect("serialize"),
    }));

    assert!(matches!(
        verify(fetch.as_ref(), "alice@example.com", &pubkey(0x11)).await,
        VerificationOutcome::Invalid { .. }
    ));

    let fetch = FakeFetch::with(Ok(FetchOutcome {
        status: 404,
        body: Vec::new(),
    }));

    assert!(matches!(
        verify(fetch.as_ref(), "alice@example.com", &pubkey(0x11)).await,
        VerificationOutcome::Error { .. }
    ));
}
