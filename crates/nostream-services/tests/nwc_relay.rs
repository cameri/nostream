//! The real NIP-47 transport against a loopback relay.
//!
//! The client publishes a kind-23194 request and correlates the kind-23195 reply by the `e`
//! tag, exactly as `@getalby/sdk` does. These tests drive it over a real websocket, so the
//! frame shapes and the correlation are exercised together.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nostream_core::crypto::sign_event;
use nostream_core::event::{Event, EventId, Kind, Signature};
use nostream_core::{Pubkey, nip04};
use nostream_services::payments::{Nip47Request, Nip47Transport, NwcRelayTransport};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const WALLET_SECRET: [u8; 32] = [7; 32];

/// `nostr+walletconnect://` for a relay on loopback.
fn nwc_url(relay: &str) -> String {
    let wallet = nostream_core::crypto::public_key(&WALLET_SECRET).expect("the wallet pubkey");
    let secret = hex::encode([9u8; 32]);

    format!("nostr+walletconnect://{wallet}?relay={relay}&secret={secret}")
}

/// The request event the client published, as the relay saw it.
struct Published {
    id: EventId,
    pubkey: Pubkey,
}

/// A websocket relay that answers the first request with `reply`.
///
/// `reply` receives the request and returns the decrypted payload the wallet would send; the
/// helper encrypts it, signs the reply event and publishes it, then closes the socket.
async fn relay(
    reply: impl FnOnce(&Published) -> (Vec<Vec<String>>, serde_json::Value) + Send + 'static,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("local addr").port();

    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.expect("accept");
        let mut socket = tokio_tungstenite::accept_async(socket)
            .await
            .expect("the handshake");
        let mut published: Option<Published> = None;
        let mut subscription = String::new();

        while published.is_none() || subscription.is_empty() {
            let Some(Ok(Message::Text(frame))) = socket.next().await else {
                break;
            };
            let frame: serde_json::Value = serde_json::from_str(&frame).expect("a frame");
            let parts = frame.as_array().expect("a frame array");

            match parts.first().and_then(serde_json::Value::as_str) {
                Some("EVENT") => {
                    let event: Event =
                        serde_json::from_value(parts[1].clone()).expect("the request event");
                    published = Some(Published {
                        id: event.id,
                        pubkey: event.pubkey,
                    });
                }
                Some("REQ") => {
                    subscription = parts[1].as_str().expect("the subscription").to_owned();
                }
                _ => {}
            }
        }

        let published = published.expect("the client publishes its request");
        let (tags, payload) = reply(&published);
        let iv = [3u8; 16];
        let content = nip04::encrypt(&WALLET_SECRET, &published.pubkey, &payload.to_string(), &iv)
            .expect("the wallet encrypts its reply");

        let mut event = Event {
            id: EventId::from_byte_array([0; 32]),
            pubkey: published.pubkey,
            created_at: chrono::Utc::now().timestamp(),
            kind: Kind(23_195),
            tags,
            content,
            sig: Signature::from_byte_array([0; 64]),
        };
        sign_event(&WALLET_SECRET, &mut event).expect("the wallet signs its reply");

        let _ = socket
            .send(Message::Text(
                json!(["EVENT", subscription, event]).to_string().into(),
            ))
            .await;
        // The client reads one frame and returns; closing here makes a discarded reply fail
        // the request instead of waiting for the transport's own deadline.
        let _ = socket.close(None).await;
    });

    format!("ws://127.0.0.1:{port}")
}

fn make_invoice() -> Nip47Request {
    Nip47Request {
        method: "make_invoice".to_owned(),
        params: json!({ "amount": 1_000, "description": "admission" }),
    }
}

#[tokio::test]
async fn a_reply_is_correlated_by_its_e_tag_not_by_a_payload_id() {
    let relay = relay(|published| {
        (
            vec![
                vec!["e".to_owned(), published.id.to_string()],
                vec!["p".to_owned(), published.pubkey.to_string()],
            ],
            // A real NIP-47 payload: `result_type`, `result`, `error`. No `id`.
            json!({
                "result_type": "make_invoice",
                "result": { "invoice": "lnbc1", "payment_hash": "ab" },
                "error": null,
            }),
        )
    })
    .await;

    let transport = NwcRelayTransport::new(&nwc_url(&relay)).expect("the url parses");
    let response = transport.request(&make_invoice()).await.expect("the reply");

    assert_eq!(
        response.result,
        json!({ "invoice": "lnbc1", "payment_hash": "ab" })
    );
}

#[tokio::test]
async fn a_reply_for_another_request_is_ignored() {
    let relay = relay(|_published| {
        (
            vec![vec!["e".to_owned(), "00".repeat(32)]],
            json!({ "result_type": "make_invoice", "result": {}, "error": null }),
        )
    })
    .await;

    let transport = NwcRelayTransport::new(&nwc_url(&relay)).expect("the url parses");
    let error = transport
        .request(&make_invoice())
        .await
        .expect_err("a reply for another request is not this request's answer");

    assert_eq!(
        error.to_string(),
        "payment processor error: NWC relay closed before a reply"
    );
}

/// Without the TLS feature `connect_async` refuses a `wss://` URL before dialling anything.
#[tokio::test]
async fn an_encrypted_relay_url_is_dialled() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("local addr").port();
    let dialled = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&dialled);

    tokio::spawn(async move {
        if let Ok((socket, _)) = listener.accept().await {
            flag.store(true, Ordering::SeqCst);
            // A plain socket cannot complete a TLS handshake: dropping it fails the connect
            // after the dial, which is what proves the `wss` path is compiled in.
            drop(socket);
        }
    });

    let transport = NwcRelayTransport::new(&nwc_url(&format!("wss://127.0.0.1:{port}")))
        .expect("the url parses");
    let error = tokio::time::timeout(Duration::from_secs(10), transport.request(&make_invoice()))
        .await
        .expect("the connection fails rather than hanging")
        .expect_err("a plain socket cannot speak TLS");

    assert!(
        dialled.load(Ordering::SeqCst),
        "the wss URL is dialled: {error}"
    );
    assert!(
        !error.to_string().contains("TLS support not compiled in"),
        "the rustls feature is enabled: {error}"
    );
}
