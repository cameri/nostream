//! The daemon serves the wire: AC2 (`R1`) — the acceptor hands the socket to the relay and
//! the first frame a client receives is the NIP-42 challenge.
//!
//! | case | Rust test |
//! |---|---|
//! | a client connects and receives `["AUTH","<43 base64url chars>"]` | `the_first_frame_is_the_nip42_challenge` |
//! | a second connection gets its own challenge | `every_connection_gets_its_own_challenge` |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use nostream_core::clock::TestClock;
use nostream_core::lifecycle::ShutdownState;
use nostream_relay::Relay;
use nostream_relay::relay_key::RelayKeySource;
use nostream_relay::testing::{Fixture, settings};
use nostreamd::Acceptor;
use tokio_tungstenite::tungstenite::Message;

async fn start() -> (u16, ShutdownState) {
    let acceptor = Acceptor::bind("127.0.0.1:0".parse().expect("socket addr"))
        .await
        .expect("bind");
    let port = acceptor.local_addr().port();

    let fixture = Fixture::new(settings());
    let relay = Relay::new(
        (*fixture.settings).clone(),
        Arc::clone(&fixture.stores),
        fixture.wot_graph(),
        Arc::new(TestClock::new(1_700_000_000_000)),
        RelayKeySource::from_values(None, None),
        Arc::new(nostream_core::random::SystemRandom),
        // Explicit, so the suite's drain deadline is its own and not the environment's.
        nostream_relay::relay::RelayConfig {
            drain_timeout: std::time::Duration::from_millis(300),
            ..Default::default()
        },
    );

    let shutdown = ShutdownState::new();
    let connection_shutdown = shutdown.clone();

    tokio::spawn(async move {
        let _ = acceptor.run(relay, connection_shutdown).await;
    });

    (port, shutdown)
}

async fn first_frame(
    port: u16,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
) {
    let (mut client, _response) = tokio::time::timeout(
        Duration::from_secs(2),
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/")),
    )
    .await
    .expect("connect within two seconds")
    .expect("handshake");

    let message = tokio::time::timeout(Duration::from_secs(2), client.next())
        .await
        .expect("a frame within two seconds")
        .expect("a frame")
        .expect("a text frame");

    let Message::Text(text) = message else {
        panic!("expected a text frame, got {message:?}");
    };

    (client, text.as_str().to_owned())
}

#[tokio::test]
async fn the_first_frame_is_the_nip42_challenge() {
    let (port, shutdown) = start().await;
    let (client, text) = first_frame(port).await;

    let frame: serde_json::Value = serde_json::from_str(&text).expect("a JSON frame");
    let array = frame.as_array().expect("a positional array");

    assert_eq!(array.first().and_then(|verb| verb.as_str()), Some("AUTH"));

    let challenge = array
        .get(1)
        .and_then(|challenge| challenge.as_str())
        .expect("a challenge");

    // 32 bytes base64url without padding is 43 characters, and only the URL-safe alphabet.
    assert_eq!(challenge.len(), 43, "{challenge}");
    assert!(
        challenge
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "{challenge}"
    );

    drop(client);
    shutdown.begin_draining();
}

#[tokio::test]
async fn every_connection_gets_its_own_challenge() {
    let (port, shutdown) = start().await;

    let (first_client, first) = first_frame(port).await;
    let (second_client, second) = first_frame(port).await;

    assert_ne!(first, second, "the challenge is per socket");

    drop(first_client);
    drop(second_client);
    shutdown.begin_draining();
}
