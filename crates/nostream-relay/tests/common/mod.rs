//! The integration tests' harness: a relay on an ephemeral port and a client that reads
//! frames with a deadline.
//!
//! Every test in this crate drives the public API only — `Relay`, `testing`'s doubles, and a
//! real websocket over loopback — so no test depends on a database, a proxy or the wall
//! clock (`TestClock` moves time explicitly).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nostream_core::clock::{Clock, TestClock};
use nostream_core::lifecycle::ShutdownState;
use nostream_relay::relay_key::RelayKeySource;
use nostream_relay::testing::Fixture;
use nostream_relay::{Relay, RelayConfig};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// The instant every test starts at: 2023-11-14T22:13:20Z.
pub const NOW_SECS: i64 = 1_700_000_000;
/// The same instant in milliseconds.
pub const NOW_MS: u64 = 1_700_000_000_000;

/// A relay serving on loopback, with its clock and fixture.
pub struct Server {
    pub address: SocketAddr,
    pub clock: Arc<TestClock>,
    pub fixture: Fixture,
    pub relay: Arc<Relay>,
    shutdown: ShutdownState,
}

impl Server {
    /// Starts a relay over `fixture` on an ephemeral port.
    pub async fn start(fixture: Fixture) -> Self {
        Self::start_with(
            fixture,
            RelayKeySource::from_values(None, None),
            fast_config(),
        )
        .await
    }

    /// Starts a relay with an explicit key source and intervals.
    pub async fn start_with(fixture: Fixture, keys: RelayKeySource, config: RelayConfig) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("local addr");
        let clock = Arc::new(TestClock::new(NOW_MS));

        let relay = Relay::with_keys(
            (*fixture.settings).clone(),
            Arc::clone(&fixture.stores),
            clock.clone(),
            keys,
        )
        .with_config(config);

        let shutdown = ShutdownState::new();
        let connection_shutdown = shutdown.clone();
        let served = Arc::clone(&relay);

        tokio::spawn(async move {
            let _ = served.serve(listener, connection_shutdown).await;
        });

        Self {
            address,
            clock,
            fixture,
            relay,
            shutdown,
        }
    }

    /// Connects a client and consumes its NIP-42 challenge frame, returning the challenge.
    pub async fn connect(&self) -> (Client, String) {
        let mut client = Client::connect(self.address).await;
        let challenge = client
            .expect_frame()
            .await
            .strip_prefix(r#"["AUTH",""#)
            .and_then(|rest| rest.strip_suffix(r#""]"#))
            .expect("the first frame is the AUTH challenge")
            .to_owned();

        (client, challenge)
    }

    /// Begins draining; the serve task stops accepting and closes every connection.
    pub fn begin_draining(&self) {
        self.shutdown.begin_draining();
    }

    /// The shared drain flag, for a test that drives `handle_socket` itself.
    pub fn shutdown(&self) -> ShutdownState {
        self.shutdown.clone()
    }
}

/// The intervals tests run with: a fast drain deadline and a liveness interval that never
/// fires unless a test asks for it.
pub fn fast_config() -> RelayConfig {
    RelayConfig {
        liveness_interval: Duration::from_secs(600),
        hidden_refresh_interval: Duration::from_secs(600),
        drain_timeout: Duration::from_millis(300),
    }
}

/// A liveness configuration with a short interval.
pub fn liveness_config(interval: Duration) -> RelayConfig {
    RelayConfig {
        liveness_interval: interval,
        ..fast_config()
    }
}

/// A websocket client with a deadline on every read.
pub struct Client {
    stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
}

impl Client {
    /// Connects to `address`.
    pub async fn connect(address: SocketAddr) -> Self {
        let (stream, _response) = tokio::time::timeout(
            Duration::from_secs(5),
            tokio_tungstenite::connect_async(format!("ws://{address}/")),
        )
        .await
        .expect("connect within five seconds")
        .expect("handshake");

        Self { stream }
    }

    /// Sends one text frame.
    pub async fn send(&mut self, text: &str) {
        self.stream
            .send(Message::Text(text.to_owned().into()))
            .await
            .expect("send");
    }

    /// The next message, or `None` when the socket closes within the deadline.
    pub async fn next_message(&mut self) -> Option<Message> {
        match tokio::time::timeout(Duration::from_secs(2), self.stream.next()).await {
            Ok(None) => None,
            Ok(Some(Ok(message))) => Some(message),
            Ok(Some(Err(error))) => panic!("client read failed: {error}"),
            Err(_) => None,
        }
    }

    /// The next message, mapping a transport failure to `None`. A terminated connection
    /// surfaces as a reset, which is the behaviour a rate-limited upgrade has.
    pub async fn next_message_lossy(&mut self) -> Option<Message> {
        match tokio::time::timeout(Duration::from_secs(2), self.stream.next()).await {
            Ok(Some(Ok(message))) => Some(message),
            _ => None,
        }
    }

    /// The next text frame, panicking when the socket closes instead.
    pub async fn expect_frame(&mut self) -> String {
        match self.next_message().await {
            Some(Message::Text(text)) => text.as_str().to_owned(),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    /// Every frame until `EOSE`, in order.
    pub async fn read_until_eose(&mut self) -> Vec<String> {
        let mut frames = Vec::new();

        loop {
            let frame = self.expect_frame().await;
            let is_eose = frame.starts_with(r#"["EOSE","#);

            frames.push(frame);

            if is_eose {
                return frames;
            }
        }
    }

    /// Whether the socket is still open: a ping gets a pong.
    pub async fn is_open(&mut self) -> bool {
        if self
            .stream
            .send(Message::Ping(vec![7u8].into()))
            .await
            .is_err()
        {
            return false;
        }

        matches!(self.next_message().await, Some(Message::Pong(_)))
    }

    /// Closes the socket.
    pub async fn close(&mut self) {
        let _ = self.stream.close(None).await;
    }

    /// The underlying stream, for a test that needs the handshake response.
    pub fn stream(&mut self) -> &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>> {
        &mut self.stream
    }
}

/// The relay's own signing key in these tests: `RELAY_PRIVATE_KEY = 01…01`.
pub const RELAY_SECRET: [u8; 32] = [1u8; 32];

/// A key source whose relay key is [`RELAY_SECRET`].
pub fn relay_keys() -> RelayKeySource {
    RelayKeySource::from_values(Some(hex::encode(RELAY_SECRET)), None)
}

/// A client's key, distinct from the relay's.
pub const CLIENT_SECRET: [u8; 32] = [7u8; 32];

/// Builds and signs an event with `secret`.
pub fn signed_event(
    secret: &[u8; 32],
    kind: u64,
    tags: Vec<Vec<&str>>,
    content: &str,
    created_at: i64,
) -> nostream_core::Event {
    use nostream_core::Kind;
    use nostream_core::event::{EventId, Pubkey, Signature};

    let mut event = nostream_core::Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(kind),
        tags: tags
            .into_iter()
            .map(|tag| tag.into_iter().map(str::to_owned).collect())
            .collect(),
        content: content.to_owned(),
        sig: Signature::from_byte_array([0; 64]),
    };

    nostream_core::crypto::sign_event(secret, &mut event).expect("sign the test event");

    event
}

/// The relay's clock as a trait object.
pub fn clock_of(server: &Server) -> Arc<dyn Clock> {
    Arc::clone(&server.clock) as Arc<dyn Clock>
}
