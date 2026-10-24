//! The websocket transport and the per-socket loop: the payload limit, the close codes, a
//! declined compression offer, liveness, client pings and the drain.
//!
//! Carries `test/unit/adapters/web-socket-server-adapter.spec.ts` (17 cases) and the framing
//! half of `web-socket-adapter.spec.ts` (60). The variants A3 and A8 call for need a raw
//! socket, because a websocket library will not make a client break the protocol on purpose:
//! RSV bits, an extension offer, and reading a ping without answering it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp
)]

mod common;

use std::time::Duration;

use common::{
    CLIENT_SECRET, Client, NOW_SECS, Server, fast_config, liveness_config, relay_keys, signed_event,
};
use futures_util::SinkExt;
use nostream_relay::testing::{Fixture, settings};
use nostream_relay::transport::{self, DEFAULT_MAX_PAYLOAD};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

// ---------------------------------------------------------------------------------------
// A raw websocket client: the handshake by hand, frames by hand.
// ---------------------------------------------------------------------------------------

/// One frame read off the wire.
#[derive(Debug, PartialEq, Eq)]
struct Frame {
    fin: bool,
    rsv1: bool,
    opcode: u8,
    payload: Vec<u8>,
}

impl Frame {
    fn text(&self) -> String {
        String::from_utf8(self.payload.clone()).expect("utf8 payload")
    }
}

struct RawClient {
    stream: TcpStream,
    /// Everything read past the last complete frame, so a read never loses bytes.
    buffered: Vec<u8>,
}

impl RawClient {
    /// Connects and completes the handshake, returning the response's headers.
    async fn connect(address: std::net::SocketAddr, extensions: Option<&str>) -> (Self, String) {
        let mut stream = TcpStream::connect(address).await.expect("connect");

        let mut request = format!(
            "GET / HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
        );

        if let Some(extensions) = extensions {
            request.push_str(&format!("Sec-WebSocket-Extensions: {extensions}\r\n"));
        }

        request.push_str("\r\n");

        stream
            .write_all(request.as_bytes())
            .await
            .expect("write handshake");

        let mut client = Self {
            stream,
            buffered: Vec::new(),
        };
        let head = client.read_until_headers_end().await;

        (client, head)
    }

    async fn read_until_headers_end(&mut self) -> String {
        loop {
            if let Some(end) = find(&self.buffered, b"\r\n\r\n") {
                let head = String::from_utf8(self.buffered[..end].to_vec()).expect("utf8 head");
                self.buffered.drain(..end + 4);

                return head;
            }

            if !self.fill().await {
                panic!("the handshake response ended early");
            }
        }
    }

    /// Appends whatever the socket has; `false` at end of stream.
    async fn fill(&mut self) -> bool {
        let mut buffer = [0u8; 4096];

        match tokio::time::timeout(Duration::from_secs(5), self.stream.read(&mut buffer)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => false,
            Ok(Ok(read)) => {
                self.buffered.extend_from_slice(&buffer[..read]);

                true
            }
        }
    }

    /// Sends a masked client frame. A text frame is masked, as the protocol requires.
    async fn send_frame(&mut self, fin: bool, rsv1: bool, opcode: u8, payload: &[u8]) {
        let mut frame = Vec::with_capacity(payload.len() + 14);
        let first = (u8::from(fin) << 7) | (u8::from(rsv1) << 6) | opcode;

        frame.push(first);

        let mask = [0x12u8, 0x34, 0x56, 0x78];

        if payload.len() < 126 {
            frame.push(0x80 | payload.len() as u8);
        } else if payload.len() <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }

        frame.extend_from_slice(&mask);

        for (index, byte) in payload.iter().enumerate() {
            frame.push(byte ^ mask[index % 4]);
        }

        self.stream.write_all(&frame).await.expect("write frame");
    }

    async fn send_text(&mut self, text: &str) {
        self.send_frame(true, false, 0x1, text.as_bytes()).await;
    }

    /// The next complete server frame, or `None` at end of stream.
    async fn next_frame(&mut self) -> Option<Frame> {
        loop {
            if let Some(frame) = self.parse_frame() {
                return Some(frame);
            }

            if !self.fill().await {
                return None;
            }
        }
    }

    fn parse_frame(&mut self) -> Option<Frame> {
        let header = self.buffered.first().copied()?;

        if self.buffered.len() < 2 {
            return None;
        }

        let second = self.buffered[1];
        let masked = second & 0x80 != 0;
        let mut length = u64::from(second & 0x7f);
        let mut offset = 2;

        if length == 126 {
            let bytes = self.buffered.get(2..4)?;
            length = u64::from(u16::from_be_bytes([bytes[0], bytes[1]]));
            offset = 4;
        } else if length == 127 {
            let bytes = self.buffered.get(2..10)?;
            length = u64::from_be_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ]);
            offset = 10;
        }

        let length = usize::try_from(length).expect("a length that fits");

        if masked {
            offset += 4;
        }

        let payload = self.buffered.get(offset..offset + length)?.to_vec();

        self.buffered.drain(..offset + length);

        Some(Frame {
            fin: header & 0x80 != 0,
            rsv1: header & 0x40 != 0,
            opcode: header & 0x0f,
            payload,
        })
    }

    /// Every frame until one arrives whose opcode matches, or the stream ends.
    async fn frames_until(&mut self, opcode: u8) -> Vec<Frame> {
        let mut frames = Vec::new();

        while let Some(frame) = self.next_frame().await {
            let matched = frame.opcode == opcode;

            frames.push(frame);

            if matched {
                break;
            }
        }

        frames
    }

    /// Reads until the stream ends, returning every frame that arrived.
    async fn frames_until_eof(&mut self) -> Vec<Frame> {
        let mut frames = Vec::new();

        while let Some(frame) = self.next_frame().await {
            frames.push(frame);
        }

        frames
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The close code and reason of a close frame.
fn close_of(frame: &Frame) -> (u16, String) {
    let code = u16::from_be_bytes([frame.payload[0], frame.payload[1]]);

    (
        code,
        String::from_utf8(frame.payload[2..].to_vec()).expect("utf8 reason"),
    )
}

fn settings_with_payload(size: u64) -> nostream_config::settings::Settings {
    let mut settings = settings();
    settings.network.max_payload_size = Some(size);

    settings
}

// ---------------------------------------------------------------------------------------
// The payload limit (R27)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn the_payload_limit_defaults_to_131072_and_follows_the_settings() {
    assert_eq!(
        transport::max_payload_size(&settings()),
        DEFAULT_MAX_PAYLOAD
    );
    assert_eq!(transport::max_payload_size(&settings()), 131_072);
    assert_eq!(
        transport::max_payload_size(&settings_with_payload(524_288)),
        524_288
    );
    // Zero and absent both fall back: `?? 131072`, then `if (!payload) 131072`.
    assert_eq!(
        transport::max_payload_size(&settings_with_payload(0)),
        DEFAULT_MAX_PAYLOAD
    );
}

#[tokio::test]
async fn an_oversized_message_is_closed_with_1009() {
    let server = Server::start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    // Above the 131072-byte default, in one frame.
    let oversized = "x".repeat(140_000);
    client.send(&oversized).await;

    let closed = client
        .next_message()
        .await
        .expect("a close frame, not a dropped socket");

    match closed {
        Message::Close(Some(frame)) => {
            assert_eq!(frame.code, CloseCode::Size);
            assert_eq!(frame.reason.as_str(), "");
        }
        other => panic!("expected a 1009 close, got {other:?}"),
    }
}

#[tokio::test]
async fn a_600kb_frame_against_a_524288_limit_closes_with_1009() {
    let server = Server::start(Fixture::new(settings_with_payload(524_288))).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(&"x".repeat(600_000)).await;

    match client.next_message().await.expect("a close frame") {
        Message::Close(Some(frame)) => assert_eq!(frame.code, CloseCode::Size),
        other => panic!("expected a 1009 close, got {other:?}"),
    }
}

#[tokio::test]
async fn the_configured_limit_is_the_one_enforced() {
    // 1024 bytes: a text frame of 2000 bytes is refused.
    let server = Server::start(Fixture::new(settings_with_payload(1024))).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(&"x".repeat(2_000)).await;

    match client.next_message().await.expect("a close frame") {
        Message::Close(Some(frame)) => assert_eq!(frame.code, CloseCode::Size),
        other => panic!("expected a 1009 close, got {other:?}"),
    }

    // The same frame under the default limit is decoded and rejected, not dropped.
    let server = Server::start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(&"x".repeat(2_000)).await;

    assert!(
        client
            .expect_frame()
            .await
            .starts_with(r#"["NOTICE","invalid: "#)
    );
}

// ---------------------------------------------------------------------------------------
// Protocol violations (R27)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_rsv_bit_with_no_negotiated_extension_is_closed_with_1002() {
    let server = Server::start(Fixture::new(settings())).await;

    // A second connection, opened before the violation, must survive it.
    let (mut survivor, challenge) = server.connect().await;
    assert!(!challenge.is_empty());

    let (mut raw, head) = RawClient::connect(server.address, None).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");

    // Consume the AUTH challenge, then break the protocol: RSV1 set with no extension.
    let auth = raw.next_frame().await.expect("the AUTH frame");
    assert_eq!(auth.opcode, 0x1);

    raw.send_frame(true, true, 0x1, br#"["REQ","s1",{}]"#).await;

    let frames = raw.frames_until(0x8).await;

    assert_eq!(frames.last().map(close_of), Some((1002, String::new())));

    // The surviving connection still answers.
    survivor.send(r#"["REQ","alive",{"kinds":[1]}]"#).await;
    assert_eq!(survivor.expect_frame().await, r#"["EOSE","alive"]"#);
}

#[tokio::test]
async fn a_fragmented_text_message_is_reassembled_before_decoding() {
    let server = Server::start(Fixture::new(settings())).await;
    let (mut raw, _head) = RawClient::connect(server.address, None).await;

    let _auth = raw.next_frame().await.expect("the AUTH frame");

    raw.send_frame(false, false, 0x1, br#"["REQ","frag","#)
        .await;
    raw.send_frame(true, false, 0x0, br#"{"kinds":[1]}]"#).await;

    let frames = raw.frames_until(0x1).await;
    let eose = frames.last().expect("a text frame");

    assert_eq!(eose.text(), r#"["EOSE","frag"]"#);
}

// ---------------------------------------------------------------------------------------
// Compression (R27)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_declined_compression_offer_leaves_the_session_uncompressed() {
    let server = Server::start(Fixture::new(settings())).await;

    let (mut raw, head) = RawClient::connect(
        server.address,
        Some("permessage-deflate; client_max_window_bits"),
    )
    .await;

    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    assert!(
        !head
            .to_ascii_lowercase()
            .contains("sec-websocket-extensions"),
        "the offer must be declined: {head}"
    );

    // The AUTH challenge arrives as a plain text frame: RSV1 clear, payload is JSON.
    let auth = raw.next_frame().await.expect("the AUTH frame");

    assert!(!auth.rsv1, "no extension was negotiated");
    assert_eq!(auth.opcode, 0x1);
    assert!(auth.text().starts_with(r#"["AUTH","#), "{auth:?}");

    // And a request is answered uncompressed too.
    raw.send_text(r#"["REQ","plain",{"kinds":[1]}]"#).await;

    let eose = raw.frames_until(0x1).await;

    assert!(eose.iter().all(|frame| !frame.rsv1));
    assert_eq!(
        eose.last().expect("a text frame").text(),
        r#"["EOSE","plain"]"#
    );
}

// ---------------------------------------------------------------------------------------
// Liveness (R26)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_client_that_never_pongs_is_closed_without_a_close_frame() {
    let interval = Duration::from_millis(20);
    let server = Server::start_with(
        Fixture::new(settings()),
        relay_keys(),
        liveness_config(interval),
    )
    .await;

    let (mut raw, _head) = RawClient::connect(server.address, None).await;

    // Read every frame — including the pings — and never answer one.
    let frames = tokio::time::timeout(Duration::from_millis(500), raw.frames_until_eof())
        .await
        .expect("the relay closes the socket within its own interval");

    let pings = frames.iter().filter(|frame| frame.opcode == 0x9).count();

    assert!(pings >= 1, "the relay pinged before giving up: {frames:?}");
    assert!(
        frames.iter().all(|frame| frame.opcode != 0x8),
        "a liveness failure closes with no code: {frames:?}"
    );
}

#[tokio::test]
async fn a_client_that_answers_every_ping_survives() {
    let interval = Duration::from_millis(20);
    let server = Server::start_with(
        Fixture::new(settings()),
        relay_keys(),
        liveness_config(interval),
    )
    .await;

    let (mut client, _challenge) = server.connect().await;
    let mut pings = 0;

    // Each read answers the server's ping at the protocol layer, which is what keeps the
    // connection alive; ten intervals must pass without a close.
    for _ in 0..10 {
        match client.next_message().await {
            Some(Message::Ping(_)) => pings += 1,
            Some(Message::Close(frame)) => panic!("closed early: {frame:?}"),
            Some(Message::Text(text)) => assert!(text.contains("AUTH")),
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    assert_eq!(pings, 10);

    client.send(r#"["REQ","still-here",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","still-here"]"#);
}

#[tokio::test]
async fn a_client_ping_is_answered_with_the_same_payload() {
    let server = Server::start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client
        .stream()
        .send(Message::Ping(b"hello".to_vec().into()))
        .await
        .expect("send a ping");

    let answer = client.next_message().await.expect("a pong");

    assert_eq!(answer, Message::Pong(b"hello".to_vec().into()));
}

// ---------------------------------------------------------------------------------------
// Drain (R26)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn draining_closes_every_subscription_then_the_socket_with_1001() {
    let server = Server::start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","s1"]"#);
    client.send(r#"["REQ","s2",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","s2"]"#);

    server.begin_draining();

    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","s1","error: relay shutting down"]"#
    );
    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","s2","error: relay shutting down"]"#
    );

    match client.next_message().await.expect("a close frame") {
        Message::Close(Some(frame)) => {
            assert_eq!(frame.code, CloseCode::Away);
            assert_eq!(frame.reason.as_str(), transport::DRAIN_REASON);
        }
        other => panic!("expected a 1001 close, got {other:?}"),
    }
}

#[tokio::test]
async fn a_connection_accepted_while_draining_is_closed_with_1001() {
    let server = Server::start(Fixture::new(settings())).await;

    // Drive the socket path directly: the serve loop stops listening the moment the flag
    // is set, so the branch is reached through `handle_socket`. The flag is set before the
    // connection task starts, which is the window a `watch` receiver created afterwards
    // would otherwise miss: the drain still produces the 1001 rather than an abort.
    let shutdown = server.shutdown();
    shutdown.begin_draining();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("local address");
    let relay = std::sync::Arc::clone(&server.relay);

    let accepting = tokio::spawn(async move {
        let (stream, peer) = listener.accept().await.expect("accept");

        relay.handle_socket(stream, peer, shutdown).await;
    });

    let mut client = Client::connect(address).await;
    let _ = accepting.await;

    match client.next_message().await.expect("a close frame") {
        Message::Close(Some(frame)) => {
            assert_eq!(frame.code, CloseCode::Away);
            assert_eq!(frame.reason.as_str(), transport::DRAIN_REASON);
        }
        other => panic!("expected a 1001 close, got {other:?}"),
    }
}

#[tokio::test]
async fn a_connection_with_no_subscriptions_is_closed_without_a_closed_frame() {
    let config = nostream_relay::relay::RelayConfig {
        drain_timeout: Duration::from_millis(50),
        ..fast_config()
    };
    let server = Server::start_with(Fixture::new(settings()), relay_keys(), config).await;

    let (mut client, _challenge) = server.connect().await;
    server.begin_draining();

    match client.next_message().await.expect("a close frame") {
        Message::Close(Some(frame)) => {
            assert_eq!(frame.code, CloseCode::Away);
            assert_eq!(frame.reason.as_str(), transport::DRAIN_REASON);
        }
        other => panic!("expected only the 1001 close, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------
// The bounded frame queue (#952)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_client_that_stops_reading_is_closed_with_1013() {
    // 32 MiB of events against the default 8 MiB queue: more than any autotuned loopback
    // buffer can absorb, so the bound is reached whatever the kernel's window is. The
    // timestamps differ so every event is a distinct row.
    let content = "x".repeat(32 * 1024);
    let fixture = Fixture::new(settings());
    // One permit per stored record, so the prefix below is a frame the client can read rather
    // than one of the whole 32 MiB the read would otherwise queue in a single poll.
    let gate = fixture.events.gate_reads_per_item();

    for index in 0..1024 {
        fixture
            .seed_event(signed_event(
                &CLIENT_SECRET,
                1,
                vec![],
                &content,
                NOW_SECS + index,
            ))
            .await;
    }

    let server = Server::start_with(fixture, relay_keys(), fast_config()).await;
    let (mut raw, _head) = RawClient::connect(server.address, None).await;

    // The socket's first frame is the NIP-42 challenge, which is a text frame on every
    // connection: read it here so nothing below counts it as a stored event.
    let challenge = raw.next_frame().await.expect("the AUTH challenge");
    assert_eq!(challenge.opcode, 0x1);
    assert!(
        challenge.text().starts_with(r#"["AUTH","#),
        "the first frame is the challenge: {}",
        challenge.text()
    );

    raw.send_text(r#"["REQ","bulk",{"kinds":[1]}]"#).await;

    // Three stored events while the client is still reading: these are the frames AC6 step 5
    // means by "at least one `EVENT` frame preceded it".
    gate.add_permits(3);

    let mut delivered = Vec::new();

    for _ in 0..3 {
        let frame = tokio::time::timeout(Duration::from_secs(5), raw.next_frame())
            .await
            .expect("a stored event arrives while the client reads")
            .expect("a stored event frame");

        assert_eq!(frame.opcode, 0x1, "{frame:?}");
        delivered.push(frame.text());
    }

    for text in &delivered {
        let event: serde_json::Value = serde_json::from_str(
            text.strip_prefix(r#"["EVENT","bulk","#)
                .and_then(|rest| rest.strip_suffix(']'))
                .expect("an EVENT frame for bulk"),
        )
        .expect("event json");

        assert_eq!(event["kind"], 1, "the stored events are the ones asked for");
    }

    // The client stops reading and the rest of the read runs at once: the queue takes what
    // the socket cannot, overflows, and the loop closes the client as soon as the blocked
    // write returns.
    gate.add_permits(1024);
    tokio::time::sleep(Duration::from_millis(500)).await;

    let frames = tokio::time::timeout(Duration::from_secs(10), raw.frames_until(0x8))
        .await
        .expect("the close frame arrives once the queue overflows");
    let last = frames.last().expect("a close frame");

    assert_eq!(last.opcode, 0x8, "the last frame is a close frame");
    assert!(
        frames.iter().all(|frame| {
            frame.opcode == 0x8 || frame.text().starts_with(r#"["EVENT","bulk","#)
        }),
        "everything the closed client still receives is a stored event: {:?}",
        frames.iter().map(Frame::text).collect::<Vec<_>>()
    );
    assert_eq!(
        close_of(last),
        (1013, transport::SLOW_CONSUMER_REASON.to_owned())
    );
}
