//! R31/R32's differential oracle: every recorded frame, replayed against the Rust relay and
//! compared as raw UTF-8 text in order.
//!
//! The fixture is `tests/fixtures/wire-sessions.json`, recorded by
//! `tests/capture/gen-wire-sessions.mjs` from the capture's real adapters and handlers. Each
//! session carries the settings document, the frozen clock, the fixture seed, the server-minted
//! values the recording depended on, and the frames the capture's relay sent for each client
//! frame.
//!
//! Comparison semantics: byte-identical after `{{challenge}}` substitution, with only the two
//! declared tolerances (T1 the detail after `invalid: ` for unparseable JSON, T2 a close frame's
//! reason when its code matches). Every session's `allow` list is summarised at the end of the
//! run; anything undeclared fails.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nostream_config::settings::Settings;
use nostream_core::clock::{Clock, TestClock};
use nostream_core::random::RecordedRandom;
use nostream_relay::relay::{Relay, RelayConfig};
use nostream_relay::relay_key::RelayKeySource;
use nostream_relay::testing::Fixture;
use nostream_storage::repositories::{ActionableTarget, User};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

const PLACEHOLDER: &str = "{{challenge}}";

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wire-sessions.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));

    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The recorded reason for a tolerated difference.
#[derive(Debug, Clone)]
struct Allow {
    why: String,
}

impl Allow {
    fn permits_json_detail(&self) -> bool {
        self.why == "T1"
    }

    fn permits_close_reason(&self) -> bool {
        self.why == "T2"
    }
}

/// How a step's frames are compared. `Json` parses both sides and compares the values, which
/// is the only difference the capture's three event-building paths leave: their objects carry
/// the same keys and values in different insertion orders, and JSON has no field order.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Compare {
    #[default]
    Text,
    Json,
}

/// One recorded step: a client frame, what the relay answered, and the declared tolerances.
#[derive(Debug, Clone, Default)]
struct Step {
    connect: bool,
    text: Option<String>,
    expect: Vec<String>,
    allow: Vec<Allow>,
    advance_ms: u64,
    none: bool,
    drain: bool,
    compare: Compare,
    oversized: Option<usize>,
}

fn parse_step(value: &Value) -> Step {
    Step {
        connect: value["connect"].as_bool().unwrap_or(false),
        text: value["send"]["text"].as_str().map(str::to_owned),
        expect: value["expect"]
            .as_array()
            .map(|frames| {
                frames
                    .iter()
                    .map(|frame| frame.as_str().expect("a frame").to_owned())
                    .collect()
            })
            .unwrap_or_default(),
        allow: value["allow"]
            .as_array()
            .map(|allows| {
                allows
                    .iter()
                    .map(|allow| Allow {
                        why: allow["why"].as_str().expect("a tolerance").to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        advance_ms: value["advance_ms"].as_u64().unwrap_or(0),
        none: value["send"].is_null() && value["drain"].is_null() && value["connect"].is_null(),
        drain: value["drain"].as_bool().unwrap_or(false),
        compare: match value["compare"].as_str() {
            Some("json") => Compare::Json,
            _ => Compare::Text,
        },
        oversized: value["oversized"].as_u64().map(|size| size as usize),
    }
}

/// One recorded session.
struct Session {
    id: String,
    settings: Settings,
    start_ms: u64,
    liveness_interval_ms: Option<u64>,
    challenge: Option<String>,
    random: Option<(String, Option<String>)>,
    relay_secret: Option<String>,
    offer_compression: bool,
    steps: Vec<Step>,
    final_close: Option<(u16, String)>,
    actionable: Vec<ActionableTarget>,
    vanished: Vec<nostream_core::Pubkey>,
    blocked: Vec<nostream_core::Pubkey>,
    skipped: bool,
}

fn parse_session(value: &Value) -> Session {
    let settings: Settings = serde_json::from_value(value["settings"].clone())
        .unwrap_or_else(|error| panic!("{}: settings: {error}", value["id"]));

    let final_close = value["final_close"].as_object().map(|close| {
        let code = match &close["code"] {
            Value::Number(number) => number.as_u64().unwrap_or(1005) as u16,
            _ => 1005,
        };

        (
            code,
            close["reason"].as_str().unwrap_or_default().to_owned(),
        )
    });

    Session {
        id: value["id"].as_str().expect("a session id").to_owned(),
        settings,
        start_ms: value["clock"]["start_ms"]
            .as_u64()
            .unwrap_or(1_700_000_000_000),
        liveness_interval_ms: value["liveness_interval_ms"].as_u64(),
        challenge: value["challenge"].as_str().map(str::to_owned),
        random: value["random"].as_object().map(|random| {
            (
                random["challenge"].as_str().unwrap_or_default().to_owned(),
                random["invite_code"].as_str().map(str::to_owned),
            )
        }),
        relay_secret: value["relay_secret"].as_str().map(str::to_owned),
        offer_compression: value["handshake"].is_object(),
        steps: value["steps"]
            .as_array()
            .expect("steps")
            .iter()
            .map(parse_step)
            .collect(),
        final_close,
        actionable: value["actionable"]
            .as_array()
            .map(|targets| {
                targets
                    .iter()
                    .map(|target| ActionableTarget {
                        reported_pubkey: target["reportedPubkey"]
                            .as_str()
                            .and_then(|text| text.parse().ok()),
                        reported_event_id: target["reportedEventId"]
                            .as_str()
                            .and_then(|text| text.parse().ok()),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        vanished: pubkeys(value["vanished"].as_array()),
        blocked: pubkeys(value["blocked"].as_array()),
        skipped: value["comparison"].as_str() == Some("skipped"),
    }
}

fn pubkeys(values: Option<&Vec<Value>>) -> Vec<nostream_core::Pubkey> {
    values
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .filter_map(|text| text.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// A relay bound to an ephemeral port, with the session's wiring.
struct Server {
    address: SocketAddr,
    clock: Arc<TestClock>,
    shutdown: nostream_core::lifecycle::ShutdownState,
}

impl Server {
    async fn start(session: &Session, random: Arc<RecordedRandom>) -> Self {
        let fixture = Fixture::new(session.settings.clone());

        for pubkey in &session.vanished {
            let mut user = user(*pubkey);

            user.is_vanished = true;
            fixture.users.insert(user);
        }

        for pubkey in &session.blocked {
            fixture.users.insert(user(*pubkey));
        }

        fixture.reports.set_targets(session.actionable.clone());

        let clock = Arc::new(TestClock::new(session.start_ms));
        let keys = match &session.relay_secret {
            Some(secret) => RelayKeySource::from_values(Some(secret.clone()), None),
            None => RelayKeySource::from_values(None, None),
        };

        let config = RelayConfig {
            liveness_interval: Duration::from_millis(
                session.liveness_interval_ms.unwrap_or(600_000),
            ),
            hidden_refresh_interval: Duration::from_secs(600),
            drain_timeout: Duration::from_millis(300),
        };

        let relay = Relay::new(
            session.settings.clone(),
            Arc::clone(&fixture.stores),
            Arc::clone(&clock) as Arc<dyn Clock>,
            keys,
            random,
            config,
        );

        // The relay's boot refresh seeds its mirror from the repository, exactly as the
        // capture's `startHiddenContentCache` does, so the targets go to the double.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("local address");
        let shutdown = nostream_core::lifecycle::ShutdownState::new();
        let connection_shutdown = shutdown.clone();
        let served = Arc::clone(&relay);

        tokio::spawn(async move {
            let _ = served.serve(listener, connection_shutdown).await;
        });

        // `serve` starts the hidden-content refresh as a task of its own, and its first tick
        // is what seeds the mirror from the report repository: replaying before it lands lets
        // a hidden event through and makes the run flake (measured 3 of 26 before this wait,
        // 0 of 12 after it). The wait comes *after* the spawn, because the task it waits on
        // does not exist until then, and only when the tick queries at all.
        let hiding = session
            .settings
            .nip56
            .as_ref()
            .is_some_and(|nip56| nip56.enabled && nip56.hide_actionable_reports);

        if hiding {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);

            while relay.hidden_content().refreshes() == 0 {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "{}: the hidden-content mirror never refreshed",
                    session.id
                );

                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }

        Self {
            address,
            clock,
            shutdown,
        }
    }
}

fn user(pubkey: nostream_core::Pubkey) -> User {
    let now = chrono::DateTime::from_timestamp(1_700_000_000, 0).expect("a timestamp");

    User {
        pubkey,
        is_admitted: false,
        is_vanished: false,
        balance: 0,
        created_at: now,
        updated_at: now,
    }
}

/// The frames a session's replay produced, with the relay's challenge masked.
struct Replay {
    frames: Vec<String>,
    allow: Vec<Allow>,
}

impl Replay {
    fn compare(&self, expected: &[String], step: &Step, session: &str) {
        let mut observed = self.frames.iter();

        for (index, want) in expected.iter().enumerate() {
            let got = observed.next().unwrap_or_else(|| {
                panic!(
                    "{session}: step {:?} expected {} frames, got {}",
                    step.text,
                    expected.len(),
                    self.frames.len()
                )
            });

            if got == want {
                continue;
            }

            if step.compare == Compare::Json && same_json(want, got) {
                continue;
            }

            if step.allow.iter().any(Allow::permits_json_detail)
                && want.starts_with(r#"["NOTICE","invalid: "#)
                && got.starts_with(r#"["NOTICE","invalid: "#)
            {
                continue;
            }

            panic!(
                "{session}: step {:?} frame {index}\n  expected: {want}\n  observed: {got}",
                step.text
            );
        }

        assert_eq!(
            self.frames.len(),
            expected.len(),
            "{session}: step {:?} sent more frames than recorded: {:?}",
            step.text,
            self.frames
        );
    }
}

/// Replays one session.
async fn replay(session: &Session, random: Arc<RecordedRandom>) -> BTreeMap<String, usize> {
    let server = Server::start(session, random).await;
    let mut counts = BTreeMap::new();

    if session.offer_compression {
        // A raw handshake that offers the extension: the response must decline it, and the
        // whole session runs over this socket, because the offer is the point of it.
        let (mut raw, response) = raw_handshake(server.address).await;

        assert!(
            response.starts_with("HTTP/1.1 101"),
            "{}: {response}",
            session.id
        );
        assert!(
            !response
                .to_ascii_lowercase()
                .contains("sec-websocket-extensions"),
            "{}: the offer must be declined: {response}",
            session.id
        );

        let auth = raw.read_frame().await.expect("the AUTH frame");
        let challenge = auth
            .text()
            .strip_prefix(r#"["AUTH",""#)
            .and_then(|rest| rest.strip_suffix(r#""]"#))
            .expect("a challenge")
            .to_owned();

        assert!(!auth.rsv1, "{}: uncompressed", session.id);

        if let Some(recorded) = &session.challenge {
            assert_eq!(&challenge, recorded, "{}: the challenge", session.id);
        }

        for step in &session.steps {
            if step.connect {
                continue;
            }

            let text = step
                .text
                .as_deref()
                .expect("a frame")
                .replace(PLACEHOLDER, &challenge);

            raw.send_text(&text).await;

            let mut frames = Vec::new();
            for _ in 0..step.expect.len() {
                let frame = raw.read_frame().await.expect("a frame");

                assert!(!frame.rsv1, "{}: uncompressed frame", session.id);
                frames.push(mask(&frame.text(), &challenge));
            }

            assert_eq!(frames, step.expect, "{}: step {:?}", session.id, text);
        }

        server.shutdown.begin_draining();
        counts.insert("steps".to_owned(), session.steps.len());
        counts.insert("allow".to_owned(), 0);

        return counts;
    }

    let (mut client, response) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(format!("ws://{}/", server.address)),
    )
    .await
    .expect("connect within five seconds")
    .expect("handshake");

    if session.offer_compression {
        assert!(
            !response.headers().contains_key("sec-websocket-extensions"),
            "{}: the library offer was declined",
            session.id
        );
    }

    let mut challenge = String::new();
    let mut allow = Vec::new();
    let mut steps = 0;

    for step in &session.steps {
        if step.connect {
            let frame = next_text(&mut client).await;

            challenge = frame
                .strip_prefix(r#"["AUTH",""#)
                .and_then(|rest| rest.strip_suffix(r#""]"#))
                .expect("the challenge")
                .to_owned();

            if let Some(recorded) = &session.challenge {
                assert_eq!(
                    &challenge, recorded,
                    "{}: the replayed challenge is the recorded one",
                    session.id
                );
            }

            for expected in &step.expect {
                assert_eq!(
                    &mask(&frame, &challenge),
                    expected,
                    "{}: the first frame is the challenge",
                    session.id
                );
            }

            steps += 1;
            continue;
        }

        if let Some(size) = step.oversized {
            // One frame past the limit: the relay answers with a close frame, compared below.
            client
                .send(Message::Text("x".repeat(size).into()))
                .await
                .expect("send the oversized frame");
            steps += 1;
            continue;
        }

        if step.advance_ms > 0 {
            server.clock.advance(step.advance_ms);
        }

        if step.drain {
            server.shutdown.begin_draining();

            let replay = collect(&mut client, step, pinned_count(session, step), &challenge).await;

            if session.skipped {
                compare_pinned(AC29, &replay, step, &session.id);
            } else {
                replay.compare(&step.expect, step, &session.id);
            }

            allow.extend(replay.allow);
            steps += 1;
            continue;
        }

        let text = step
            .text
            .as_deref()
            .expect("a step sends a frame")
            .replace(PLACEHOLDER, &challenge);

        client
            .send(Message::Text(text.clone().into()))
            .await
            .unwrap_or_else(|error| panic!("{}: send: {error}", session.id));

        if step.none {
            tokio::time::sleep(Duration::from_millis(250)).await;

            let silent = tokio::time::timeout(Duration::from_millis(1), client.next()).await;

            assert!(
                silent.is_err(),
                "{}: step {:?} promised no frame",
                session.id,
                text
            );
            steps += 1;
            continue;
        }

        let replay = collect(&mut client, step, pinned_count(session, step), &challenge).await;

        if session.skipped {
            compare_pinned(AC29, &replay, step, &session.id);
        } else {
            replay.compare(&step.expect, step, &session.id);
        }

        allow.extend(replay.allow);
        counts.insert(format!("step{steps}"), replay.frames.len());
        steps += 1;
    }

    if let Some((code, reason)) = &session.final_close {
        if *code == 1005 {
            // The capture's relay drops the socket without a close frame: read until the
            // stream ends, and a close frame is a failure.
            let deadline = std::time::Instant::now() + Duration::from_secs(5);

            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());

                match tokio::time::timeout(remaining, client.next()).await {
                    Ok(None) | Ok(Some(Err(_))) | Err(_) => break,
                    Ok(Some(Ok(Message::Close(frame)))) => {
                        panic!(
                            "{}: closed with a frame {frame:?}, not silently",
                            session.id
                        )
                    }
                    Ok(Some(Ok(_))) => continue,
                }
            }
        } else {
            let closed = tokio::time::timeout(Duration::from_secs(5), client.next())
                .await
                .unwrap_or_else(|_| panic!("{}: a close frame, not silence", session.id))
                .unwrap_or_else(|| panic!("{}: the socket ended without a frame", session.id));

            match closed {
                Ok(Message::Close(Some(frame))) => {
                    let observed = u16::from(frame.code);

                    assert_eq!(observed, *code, "{}: close code", session.id);
                    if !allow.iter().any(Allow::permits_close_reason) && !reason.is_empty() {
                        assert_eq!(
                            frame.reason.as_str(),
                            reason,
                            "{}: close reason",
                            session.id
                        );
                    }
                }
                other => panic!(
                    "{}: expected close {code} {:?}, got {other:?}",
                    session.id, reason
                ),
            }
        }
    }

    server.shutdown.begin_draining();
    counts.insert("steps".to_owned(), steps);
    counts.insert("allow".to_owned(), allow.len());
    counts
}

/// Reads `step.expect.len()` frames, masking the challenge in each.
async fn collect(
    client: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    step: &Step,
    count: usize,
    challenge: &str,
) -> Replay {
    let mut frames = Vec::new();

    for _ in 0..count {
        let frame = next_text(client).await;

        frames.push(mask(&frame, challenge));
    }

    Replay {
        frames,
        allow: step.allow.clone(),
    }
}

/// What the Rust relay answers in the one session the capture records no frame for: with no
/// `SECRET` the capture logs and sends nothing, while AC29 requires an `OK` refusing the
/// event. It lives here rather than in the fixture, which is a recording, and it is compared
/// like every other frame, so a corrupted expectation cannot pass.
const AC29: &[&str] = &[r#"["OK","{{event_id}}",false,"error: unable to process event"]"#];

/// How many frames a skipped session's step is read for: the harness's own expectation
/// replaces the empty recording.
fn pinned_count(session: &Session, step: &Step) -> usize {
    if session.skipped {
        AC29.len()
    } else {
        step.expect.len()
    }
}

/// Compares a skipped session's frames against the harness's own expectation (AC29), so the
/// skip is a declared capture gap and not an unchecked session.
fn compare_pinned(expected: &[&str], replay: &Replay, step: &Step, session: &str) {
    let event_id = step
        .text
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value[1]["id"].as_str().map(str::to_owned))
        .unwrap_or_default();

    let expected: Vec<String> = expected
        .iter()
        .map(|frame| frame.replace("{{event_id}}", &event_id))
        .collect();

    assert_eq!(
        replay.frames, expected,
        "{session}: the AC29 frame the capture does not record"
    );
}

/// Whether two frames are the same JSON value: the same keys, values and array order, with
/// one exception. A relay-minted event's signature depends on the auxiliary random the signer
/// drew, which is not wire semantics, so an `EVENT` frame whose only difference is `sig` is
/// accepted when the observed signature verifies against the observed event.
fn same_json(left: &str, right: &str) -> bool {
    let (Ok(left), Ok(right)) = (
        serde_json::from_str::<Value>(left),
        serde_json::from_str::<Value>(right),
    ) else {
        return false;
    };

    left == right || (relay_signed_event(&left, &right) && verified_event(&right))
}

/// Whether `got` is `want` with a different `sig` and nothing else.
fn relay_signed_event(want: &Value, got: &Value) -> bool {
    let (Some(want), Some(got)) = (want.as_array(), got.as_array()) else {
        return false;
    };

    if want.len() != 3 || got.len() != 3 || want[0] != got[0] || want[1] != got[1] {
        return false;
    }

    let (Value::Object(mut want_event), Value::Object(mut got_event)) =
        (want[2].clone(), got[2].clone())
    else {
        return false;
    };

    let want_sig = want_event.remove("sig");
    let got_sig = got_event.remove("sig");

    if want_sig == got_sig {
        return false;
    }

    Value::Object(want_event) == Value::Object(got_event)
}

/// Whether the frame's event is the one its own id and signature describe.
fn verified_event(frame: &Value) -> bool {
    let Some(event) = frame
        .as_array()
        .and_then(|items| items.get(2))
        .cloned()
        .and_then(|event| serde_json::from_value::<nostream_core::Event>(event).ok())
    else {
        return false;
    };

    nostream_core::crypto::verify_event_signature(&event).is_ok()
        && nostream_core::crypto::compute_event_id(&event).is_ok_and(|id| id == event.id)
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
        .collect()
}

fn mask(frame: &str, challenge: &str) -> String {
    frame.replace(challenge, PLACEHOLDER)
}

async fn next_text(
    client: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> String {
    let message = tokio::time::timeout(Duration::from_secs(5), client.next())
        .await
        .expect("a frame within five seconds")
        .expect("a message");

    match message {
        Ok(Message::Text(text)) => text.as_str().to_owned(),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------
// A raw handshake, for the compression offer the websocket library will not make.
// ---------------------------------------------------------------------------------------

struct Raw {
    stream: tokio::net::TcpStream,
    buffered: Vec<u8>,
}

#[derive(Debug)]
struct RawFrame {
    rsv1: bool,
    payload: Vec<u8>,
}

impl RawFrame {
    fn text(&self) -> String {
        String::from_utf8(self.payload.clone()).expect("utf8")
    }
}

async fn raw_handshake(address: SocketAddr) -> (Raw, String) {
    use tokio::io::AsyncWriteExt;

    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect");
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n"
    );

    stream
        .write_all(request.as_bytes())
        .await
        .expect("write handshake");

    let mut raw = Raw {
        stream,
        buffered: Vec::new(),
    };
    let head = raw.read_until_headers_end().await;

    (raw, head)
}

impl Raw {
    /// Sends one masked client text frame.
    async fn send_text(&mut self, text: &str) {
        use tokio::io::AsyncWriteExt;

        let payload = text.as_bytes();
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut frame = Vec::with_capacity(payload.len() + 14);

        frame.push(0x81);

        if payload.len() < 126 {
            frame.push(0x80 | payload.len() as u8);
        } else {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }

        frame.extend_from_slice(&mask);

        for (index, byte) in payload.iter().enumerate() {
            frame.push(byte ^ mask[index % 4]);
        }

        self.stream.write_all(&frame).await.expect("write frame");
    }

    async fn read_until_headers_end(&mut self) -> String {
        use tokio::io::AsyncReadExt;

        loop {
            if let Some(end) = find(&self.buffered, b"\r\n\r\n") {
                let head = String::from_utf8(self.buffered[..end].to_vec()).expect("utf8 head");
                self.buffered.drain(..end + 4);

                return head;
            }

            let mut buffer = [0u8; 4096];
            let read = self.stream.read(&mut buffer).await.expect("read");

            assert!(read > 0, "the handshake response ended early");
            self.buffered.extend_from_slice(&buffer[..read]);
        }
    }

    async fn read_frame(&mut self) -> Option<RawFrame> {
        use tokio::io::AsyncReadExt;

        loop {
            if let Some(frame) = self.parse_frame() {
                return Some(frame);
            }

            let mut buffer = [0u8; 4096];
            let read = self.stream.read(&mut buffer).await.expect("read");

            if read == 0 {
                return None;
            }

            self.buffered.extend_from_slice(&buffer[..read]);
        }
    }

    fn parse_frame(&mut self) -> Option<RawFrame> {
        let header = self.buffered.first().copied()?;

        if self.buffered.len() < 2 {
            return None;
        }

        let second = self.buffered[1];
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
        let payload = self.buffered.get(offset..offset + length)?.to_vec();

        self.buffered.drain(..offset + length);

        Some(RawFrame {
            rsv1: header & 0x40 != 0,
            payload,
        })
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn every_recorded_session_replays_frame_for_frame() {
    let fixture = fixture();
    let seed = fixture["seed"].as_u64().expect("a seed");

    assert_eq!(
        fixture["clock"]["start_ms"].as_u64(),
        Some(1_700_000_000_000),
        "the recording declares its frozen clock"
    );

    // Each session carries the bytes its relay minted; a fresh source per session replays them,
    // so the fixture does not depend on a generator's position in a shared stream.
    let _ = seed;
    let sessions: Vec<Session> = fixture["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .map(parse_session)
        .collect();

    let ids: Vec<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
    for required in [
        "measured-session",
        "rate-limit-message",
        "rate-limit-event",
        "whitelists",
        "req-auth-required",
        "req-close-abort",
        "invite-mint",
        "live-dispatch",
        "hidden-report",
        "no-secret",
        "drain",
        "liveness",
        "compression-offer",
        "count-disabled",
        "nip42-expiry",
        "event-rejections",
    ] {
        assert!(
            ids.contains(&required),
            "the fixture is missing the {required} session: {ids:?}"
        );
    }

    let mut tolerances = 0;
    let mut frames = 0;

    for session in &sessions {
        let mut draws = Vec::new();

        if let Some((challenge, invite_code)) = &session.random {
            draws.push(hex_to_bytes(challenge));

            if let Some(code) = invite_code {
                draws.push(hex_to_bytes(code));
            }
        }

        let counts = replay(session, Arc::new(RecordedRandom::new(draws))).await;

        tolerances += counts.get("allow").copied().unwrap_or(0);
        frames += counts.get("steps").copied().unwrap_or(0);

        println!(
            "{}: {} steps{}",
            session.id,
            counts.get("steps").copied().unwrap_or(0),
            if session.skipped {
                " (declared not compared)"
            } else {
                ""
            }
        );
    }

    println!(
        "{frames} steps over {} sessions, {tolerances} declared tolerances",
        sessions.len()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn every_declared_tolerance_is_one_of_the_two() {
    let fixture = fixture();
    let mut tolerances = Vec::new();

    for session in fixture["sessions"].as_array().expect("sessions") {
        for step in session["steps"].as_array().expect("steps") {
            for allow in step["allow"].as_array().into_iter().flatten() {
                let why = allow["why"].as_str().expect("a tolerance").to_owned();

                assert!(
                    why == "T1" || why == "T2",
                    "{}: undeclared tolerance {why}",
                    session["id"]
                );
                tolerances.push(why);
            }
        }
    }

    println!("declared tolerances: {tolerances:?}");

    let mut t1 = 0;
    let mut t2 = 0;
    for why in &tolerances {
        if why == "T1" {
            t1 += 1;
        } else {
            t2 += 1;
        }
    }

    assert_eq!(t1 + t2, tolerances.len());
}

/// The oracle's two exceptions are counted, not assumed: a step compared as JSON values (the
/// capture's three event-building paths disagree about key order) and a session whose frames
/// the capture does not record (AC29). Weakening the fixture by another step or session fails
/// here, and each exception still compares everything but its declared difference.
#[test]
fn the_not_byte_compared_steps_are_exactly_the_declared_two_and_one_session() {
    let fixture = fixture();
    let mut json_steps = Vec::new();

    for session in fixture["sessions"].as_array().expect("sessions") {
        let id = session["id"].as_str().expect("a session id");

        for (index, step) in session["steps"]
            .as_array()
            .expect("steps")
            .iter()
            .enumerate()
        {
            if step["compare"].as_str() == Some("json") {
                assert!(
                    step["compare_why"]
                        .as_str()
                        .is_some_and(|why| !why.is_empty()),
                    "{id}: step {index} is not byte compared and says why"
                );
                json_steps.push(format!("{id}:{index}"));
            }
        }
    }

    assert_eq!(
        json_steps,
        ["measured-session:13", "invite-mint:2"],
        "the steps compared as JSON values"
    );

    let skipped: Vec<&str> = fixture["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .filter(|session| session["comparison"].as_str() == Some("skipped"))
        .map(|session| session["id"].as_str().expect("a session id"))
        .collect();

    assert_eq!(skipped, ["no-secret"], "the sessions compared by AC29");
}

/// A corrupted expectation is a failure in every comparison mode, so an edit that switches a
/// step off or garbles it cannot leave the oracle green.
#[test]
fn a_corrupted_expected_frame_fails_the_replay() {
    let frame = r#"["EVENT","s1",{"id":"aa","pubkey":"bb","created_at":1,"kind":1,"tags":[],"content":"x","sig":"cc"}]"#;
    let reordered = r#"["EVENT","s1",{"kind":1,"created_at":1,"pubkey":"bb","id":"aa","content":"x","tags":[],"sig":"cc"}]"#;

    let text = Step {
        expect: vec![frame.to_owned()],
        ..Step::default()
    };
    let json = Step {
        compare: Compare::Json,
        expect: vec![frame.to_owned()],
        ..Step::default()
    };
    let replay = |observed: &str| Replay {
        frames: vec![observed.to_owned()],
        allow: Vec::new(),
    };

    // The failures below are the point of the test: keep them out of a green run's output.
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));

    // The mode that ignores key order ignores only key order.
    assert!(
        std::panic::catch_unwind(|| replay(reordered).compare(&json.expect, &json, "probe"))
            .is_ok(),
        "a reordered frame is the same value"
    );

    let tampered = reordered.replace(r#""content":"x""#, r#""content":"garbage""#);

    for (step, observed) in [
        (&text, reordered),
        (&json, tampered.as_str()),
        (&json, r#"["EVENT","s1","garbage"]"#),
    ] {
        assert!(
            std::panic::catch_unwind(|| replay(observed).compare(&step.expect, step, "probe"))
                .is_err(),
            "{step:?} accepted {observed}"
        );
    }

    std::panic::set_hook(hook);
}

#[test]
fn the_fixture_seeds_the_client_key_the_frames_were_signed_with() {
    let fixture = fixture();
    let secret = hex_to_bytes(fixture["client_secret"].as_str().expect("a client secret"));
    let mut secret_bytes = [0u8; 32];
    secret_bytes.copy_from_slice(&secret);

    let pubkey = nostream_core::crypto::public_key(&secret_bytes).expect("a public key");

    // The recorded secret is the key that signed the recorded frames: some of the fixture's
    // frames are deliberately malformed (the rejections session) and one session signs with
    // a second key (the whitelist), so the proof is that a frame's author is the derived
    // pubkey and its signature verifies, not that every frame does.
    let mut authored = 0;

    for session in fixture["sessions"].as_array().expect("sessions") {
        for step in session["steps"].as_array().expect("steps") {
            let Some(text) = step["send"]["text"].as_str() else {
                continue;
            };
            let Ok(frame) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            let Some(event) = frame
                .as_array()
                .and_then(|items| items.get(1))
                .cloned()
                .and_then(|event| serde_json::from_value::<nostream_core::Event>(event).ok())
            else {
                continue;
            };

            authored += usize::from(
                event.pubkey == pubkey
                    && nostream_core::crypto::verify_event_signature(&event).is_ok(),
            );
        }
    }

    assert!(
        authored > 0,
        "the recorded client secret authors a frame whose signature verifies"
    );
}
